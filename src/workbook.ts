/**
 * Multi-sheet workbooks: several CSV files treated as one workbook,
 * one sheet per file. A workbook is loaded from a directory (every
 * `.csv` file becomes a sheet) or from an explicit list of files.
 *
 * Sheet names come from file names (no extension). Duplicates are
 * disambiguated the same way duplicate CSV headers are — `sales`,
 * `sales_2` — so loading never silently drops a sheet.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { answerQuestion, composeAbstention, composeAnswer } from "./answer.js";
import { parseCsv, CsvParseError, type ParsedCsv } from "./csv.js";
import { executeQuery, type QueryResult } from "./engine.js";
import { normalize, parseQuestion } from "./query.js";
import { inferSchema } from "./schema.js";

/** A workbook load or lookup failure with a user-facing message. */
export class WorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookError";
  }
}

/** A named collection of parsed sheets, in load order. */
export interface Workbook {
  sheets: Map<string, ParsedCsv>;
}

/** Sheet name for a file path: base name without the extension. */
export function sheetNameFromPath(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function uniqueName(taken: Set<string>, wanted: string): string {
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted}_${n}`)) n += 1;
  return `${wanted}_${n}`;
}

function loadFileAsSheet(path: string): { name: string; parsed: ParsedCsv } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new WorkbookError(`Cannot read file: ${path} (${code})`);
  }
  try {
    return { name: sheetNameFromPath(path), parsed: parseCsv(text) };
  } catch (err) {
    if (err instanceof CsvParseError) {
      throw new WorkbookError(`Cannot parse ${path}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Load a workbook from an explicit list of CSV files. At least one
 * file is required; duplicate sheet names get a `_2` suffix.
 */
export function loadWorkbookFromFiles(paths: string[]): Workbook {
  if (paths.length === 0) {
    throw new WorkbookError("No files given — pass at least one CSV file.");
  }
  const sheets = new Map<string, ParsedCsv>();
  for (const path of paths) {
    const { name, parsed } = loadFileAsSheet(path);
    sheets.set(uniqueName(new Set(sheets.keys()), name), parsed);
  }
  return { sheets };
}

/**
 * Load a workbook from a directory: every `.csv` file inside becomes
 * a sheet, in sorted file order. Errors when the path is not a
 * directory or contains no CSV files.
 */
export function loadWorkbookFromDir(dir: string): Workbook {
  let stat;
  try {
    stat = statSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new WorkbookError(`Cannot read directory: ${dir} (${code})`);
  }
  if (!stat.isDirectory()) {
    throw new WorkbookError(`${dir} is not a directory.`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => join(dir, f));
  if (files.length === 0) {
    throw new WorkbookError(`No CSV files found in ${dir}.`);
  }
  return loadWorkbookFromFiles(files);
}

/** Sheet names in load order. */
export function listSheets(workbook: Workbook): string[] {
  return [...workbook.sheets.keys()];
}

type SheetRoute =
  | { ok: true; sheet: string; parsed: ParsedCsv; question: string }
  | { ok: false; answer: string };

/**
 * Route a question to one sheet: preferred sheet wins, then a
 * trailing "in|from|on <sheet>" clause, then a single-sheet
 * workbook; otherwise abstain and list the sheets.
 */
function routeQuestion(
  question: string,
  workbook: Workbook,
  preferredSheet?: string,
): SheetRoute {
  const sheets = listSheets(workbook);
  if (sheets.length === 0) {
    return { ok: false, answer: "I can't answer that from this data: the workbook has no sheets." };
  }
  if (preferredSheet !== undefined) {
    const parsed = getSheet(workbook, preferredSheet);
    if (!parsed) {
      return {
        ok: false,
        answer:
          `I can't answer that from this data: there is no sheet named "${preferredSheet}". ` +
          `Sheets available: ${sheets.join(", ")}.`,
      };
    }
    return { ok: true, sheet: sheetNameOf(workbook, preferredSheet)!, parsed, question };
  }
  const extracted = extractSheetReference(question, sheets);
  if (extracted) {
    return {
      ok: true,
      sheet: extracted.sheet,
      parsed: getSheet(workbook, extracted.sheet)!,
      question: extracted.rest,
    };
  }
  if (sheets.length === 1) {
    return { ok: true, sheet: sheets[0], parsed: workbook.sheets.get(sheets[0])!, question };
  }
  return {
    ok: false,
    answer:
      `I can't answer that from this data: the question does not say which sheet to use. ` +
      `Sheets available: ${sheets.join(", ")} — say e.g. "total revenue in ${sheets[0]}".`,
  };
}

/**
 * Ask a question against a workbook: pick the sheet, then answer
 * from it. Returns the sheet used (null when the question could not
 * be routed to a sheet) and the answer text. See {@link routeQuestion}
 * for the routing order.
 */
export function askWorkbook(
  question: string,
  workbook: Workbook,
  preferredSheet?: string,
): { sheet: string | null; answer: string } {
  const route = routeQuestion(question, workbook, preferredSheet);
  if (!route.ok) return { sheet: null, answer: route.answer };
  return { sheet: route.sheet, answer: answerQuestion(route.question, route.parsed) };
}

/**
 * Like {@link askWorkbook} but also returns the structured query
 * result (null when the engine abstained), for `--json` output.
 */
export function askWorkbookDetailed(
  question: string,
  workbook: Workbook,
  preferredSheet?: string,
): { sheet: string | null; answer: string; result: QueryResult | null } {
  const route = routeQuestion(question, workbook, preferredSheet);
  if (!route.ok) return { sheet: null, answer: route.answer, result: null };
  const parsedQuestion = parseQuestion(route.question, route.parsed);
  if (!parsedQuestion.ok) {
    return {
      sheet: route.sheet,
      answer: composeAbstention(
        parsedQuestion.reason,
        inferSchema(route.parsed).map((c) => c.name),
      ),
      result: null,
    };
  }
  const result = executeQuery(parsedQuestion.query, route.parsed);
  return { sheet: route.sheet, answer: composeAnswer(result, route.parsed), result };
}
function sheetNameOf(workbook: Workbook, name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  for (const sheetName of workbook.sheets.keys()) {
    if (sheetName.toLowerCase() === wanted) return sheetName;
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull a trailing "in|from|on <sheet>" clause out of the question.
 * Sheet names are matched on their normalized form (case, `_`/`-`
 * and punctuation ignored), longest first so "sales q1" wins over
 * "sales". Returns the sheet's canonical name and the question with
 * the clause removed, or null when no sheet is named.
 */
function extractSheetReference(
  question: string,
  sheets: string[],
): { sheet: string; rest: string } | null {
  const norm = normalize(question);
  const byLength = [...sheets].sort((a, b) => b.length - a.length);
  for (const sheet of byLength) {
    const name = normalize(sheet);
    if (!name) continue;
    const re = new RegExp(`\\b(?:in|from|on)\\s+${escapeRegExp(name)}\\s*$`);
    const m = re.exec(norm);
    if (!m) continue;
    return { sheet, rest: norm.slice(0, m.index).trim() };
  }
  return null;
}

/**
 * Look a sheet up by name, case-insensitively ("Sales" finds
 * "sales"). Returns undefined when there is no such sheet.
 */
export function getSheet(workbook: Workbook, name: string): ParsedCsv | undefined {
  const wanted = name.trim().toLowerCase();
  for (const [sheetName, parsed] of workbook.sheets) {
    if (sheetName.toLowerCase() === wanted) return parsed;
  }
  return undefined;
}
