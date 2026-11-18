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
import { parseCsv, CsvParseError, type ParsedCsv } from "./csv.js";

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
