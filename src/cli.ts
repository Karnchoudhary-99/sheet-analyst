#!/usr/bin/env node
/**
 * CLI: `sheet <command> <file.csv> [args]`
 *
 *   sheet columns <file> [--json]   list columns with inferred types
 *   sheet describe <file> [--json]  per-column descriptive statistics
 *   sheet profile <file> [--json]   data-quality report
 *   sheet ask <file> <question> [--json]
 *                                    answer a plain-English question
 *
 * Exit codes: 0 success (an honest abstention still exits 0 — the
 * question was answered, just not from this data), 1 file/CSV error,
 * 2 usage error (unknown command, missing argument, unknown flag).
 *
 * `runCli` takes an output sink so tests can capture output without
 * spawning a process; the real process wiring is at the bottom.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  answerQuestion,
  composeAbstention,
  composeAnswer,
  formatNumber,
} from "./answer.js";
import { CsvParseError, parseCsv, type ParsedCsv } from "./csv.js";
import { executeQuery, type QueryResult } from "./engine.js";
import { VERSION } from "./index.js";
import { parseQuestion } from "./query.js";
import { inferSchema, type ColumnInfo } from "./schema.js";
import { profileSheet, type SheetProfile } from "./profile.js";
import { describe, type ColumnStats } from "./stats.js";
import {
  renderResultChart,
  renderResultChartSvg,
  sparkline,
} from "./charts.js";
import {
  askWorkbook,
  askWorkbookDetailed,
  getSheet,
  listSheets,
  loadWorkbookFromDir,
  loadWorkbookFromFiles,
  WorkbookError,
  type Workbook,
} from "./workbook.js";

export interface CliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_OUTPUT: CliOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** An expected, user-facing failure with the exit code to report. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export const USAGE = `sheet — chat with your CSVs from the command line

Usage:
  sheet columns <file.csv> [--json]    list columns with inferred types
  sheet describe <file.csv> [--json]   per-column descriptive statistics
  sheet profile <file.csv> [--json]    data-quality report (nulls, duplicates, outliers)
  sheet ask <file.csv> <question> [--json]
                                        answer a plain-English question
  sheet chart <file.csv> <question> [--svg <path>]
                                        chart a group-by answer
  sheet sheets <directory>             list the sheets in a workbook
  sheet --help                         show this help
  sheet --version                      show the version

A <file.csv> may also be a directory: every .csv inside becomes a
sheet of one workbook. Use --sheet <name> to pick a sheet, or name
it in the question ("total revenue in sales").

Options:
  --json    machine-readable JSON instead of human-readable text
  --sheet <name>  which sheet of a workbook to use
  --svg <path>  with chart: also write the chart as an SVG file
  --help    show help for sheet, or for a command (sheet ask --help)
`;

const COMMAND_HELP: Record<string, string> = {
  columns: `Usage: sheet columns <file.csv> [--json]

List every column with its inferred type, null count, distinct count
and a few sample values. With --json the output is the schema array
(name, type, sample, nullCount, distinctCount).
`,
  describe: `Usage: sheet describe <file.csv> [--json]

Summarize every column: numeric columns get count, min/max, mean,
median and population stddev; date columns get their range and median
date; text and boolean columns get their most common values. With
--json the output is an array of { name, type, stats } objects.
`,
  profile: `Usage: sheet profile <file.csv> [--json]

Report on the quality of the data before trusting answers from it:
duplicate and empty rows, per-column null rates, constant columns,
cells with leading/trailing whitespace, and numeric outliers by the
Tukey IQR fence. Warnings name the column and the count; a clean
sheet says so plainly. With --json the output is the profile object
(rows, columnCount, duplicateRows, emptyRows, columns, warnings).
`,
  ask: `Usage: sheet ask <file.csv> <question> [--json]

Ask a plain-English question about the sheet and print the answer
computed from the data — or an honest "I can't answer that" when the
question cannot be understood from this sheet. The question may be
several words; quoting it is optional. With --json the output is
{ question, answer, result } where result is the structured query
result, or null when the engine abstained.

The file may be a directory (a workbook): name the sheet in the
question ("total revenue in sales") or pass --sheet <name>.
`,
  sheets: `Usage: sheet sheets <directory>

List the sheets of a workbook: one line per sheet with its row
count. A single .csv file is a one-sheet workbook.
`,
  chart: `Usage: sheet chart <file.csv> <question> [--svg <path>]

Ask a question and draw the answer as a chart: a bar chart for
group-by answers (e.g. "total revenue by region"), a line chart for
time-grouped answers (e.g. "total revenue by month"). A scalar or
row answer prints the answer with a note that there is nothing to
chart. With --svg <path> the chart is also written as an SVG file.
The file may be a directory (a workbook): name the sheet in the
question or pass --sheet <name>.
`,
};

export type CommandName = "columns" | "describe" | "ask" | "sheets" | "chart" | "profile";

export interface ParsedArgs {
  command: CommandName | "help" | "version";
  /** Command the help was requested for, when `command` is "help". */
  helpFor?: CommandName;
  file?: string;
  /** The question words for `ask`, joined with spaces. */
  question?: string;
  /** Workbook sheet to use, from `--sheet <name>`. */
  sheet?: string;
  /** SVG output path, from `--svg <path>` (chart command). */
  svg?: string;
  json: boolean;
}

const COMMANDS = new Set(["columns", "describe", "ask", "sheets", "chart", "profile"]);

/**
 * Parse argv (without the node/script entries) into a command.
 * Throws CliError (exit code 2) on any usage problem.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined) {
    throw new CliError(`No command given.\n${USAGE}`, 2);
  }
  if (first === "--help" || first === "-h") {
    if (rest.length > 0) {
      throw new CliError(`Unexpected argument after --help: ${rest[0]}`, 2);
    }
    return { command: "help", json: false };
  }
  if (first === "--version" || first === "-v") {
    if (rest.length > 0) {
      throw new CliError(`Unexpected argument after --version: ${rest[0]}`, 2);
    }
    return { command: "version", json: false };
  }
  if (!COMMANDS.has(first)) {
    throw new CliError(`Unknown command: ${first}\n${USAGE}`, 2);
  }
  const command = first as CommandName;

  // Split off flags (--json, --sheet <name>, --help) from positionals.
  // A flag may appear anywhere after the command; anything else is
  // positional.
  const positionals: string[] = [];
  let json = false;
  let sheet: string | undefined;
  let svg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--sheet") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliError(`--sheet needs a sheet name.\n${COMMAND_HELP[command]}`, 2);
      }
      sheet = value;
      i += 1;
    } else if (arg === "--svg") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliError(`--svg needs a file path.\n${COMMAND_HELP[command]}`, 2);
      }
      svg = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", helpFor: command, json: false };
    } else if (arg.startsWith("-")) {
      throw new CliError(`Unknown flag: ${arg}`, 2);
    } else {
      positionals.push(arg);
    }
  }

  if (svg !== undefined && command !== "chart") {
    throw new CliError(`--svg is only for the chart command.\n${COMMAND_HELP[command]}`, 2);
  }
  const [file, ...questionWords] = positionals;
  if (file === undefined) {
    throw new CliError(
      `Missing file argument.\n${COMMAND_HELP[command]}`,
      2,
    );
  }
  if (command === "ask" || command === "chart") {
    if (questionWords.length === 0) {
      throw new CliError(
        `Missing question.\n${COMMAND_HELP[command]}`,
        2,
      );
    }
    return { command, file, question: questionWords.join(" "), sheet, svg, json };
  }
  if (questionWords.length > 0) {
    throw new CliError(
      `Unexpected argument: ${questionWords[0]}\n${COMMAND_HELP[command]}`,
      2,
    );
  }
  return { command, file, sheet, svg, json };
}

/** Load a workbook from a path: a directory becomes a multi-sheet workbook, a file a one-sheet workbook. */
export function loadWorkbook(path: string): Workbook {
  try {
    const stat = statSync(path);
    return stat.isDirectory()
      ? loadWorkbookFromDir(path)
      : loadWorkbookFromFiles([path]);
  } catch (err) {
    if (err instanceof WorkbookError) throw new CliError(err.message);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`Cannot read file: ${path} (ENOENT)`);
    }
    throw err;
  }
}

/**
 * Pick the sheet a columns/describe command works on: `--sheet`
 * wins, a one-sheet workbook needs no choice, and a multi-sheet
 * workbook without `--sheet` is a usage error naming the sheets.
 */
export function resolveSheet(workbook: Workbook, sheetName?: string): ParsedCsv {
  const sheets = listSheets(workbook);
  if (sheetName !== undefined) {
    const parsed = getSheet(workbook, sheetName);
    if (!parsed) {
      throw new CliError(
        `No sheet named "${sheetName}". Sheets available: ${sheets.join(", ")}.`,
        2,
      );
    }
    return parsed;
  }
  if (sheets.length === 1) return workbook.sheets.get(sheets[0])!;
  throw new CliError(
    `Multiple sheets — use --sheet <name>. Sheets available: ${sheets.join(", ")}.`,
    2,
  );
}

/** Read a CSV file and parse it, or throw a user-facing CliError. */
export function loadSheet(path: string): ParsedCsv {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new CliError(`Cannot read file: ${path} (${code})`);
  }
  try {
    return parseCsv(text);
  } catch (err) {
    if (err instanceof CsvParseError) {
      throw new CliError(`Cannot parse ${path}: ${err.message}`);
    }
    throw err;
  }
}

/** Pad a cell to `width` with spaces (left-aligned). */
function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}

export function formatColumnsText(parsed: ParsedCsv): string {
  const schema = inferSchema(parsed);
  const rows = parsed.rows.length;
  const nameWidth = Math.max(
    "column".length,
    ...schema.map((c) => c.name.length),
  );
  const typeWidth = Math.max(
    "type".length,
    ...schema.map((c) => c.type.length),
  );
  const lines = [
    `${rows} ${rows === 1 ? "row" : "rows"}, ${schema.length} ${schema.length === 1 ? "column" : "columns"}`,
    `${pad("column", nameWidth)}  ${pad("type", typeWidth)}  nulls  distinct  sample`,
  ];
  for (const col of schema) {
    const sample = col.sample.slice(0, 3).join(", ");
    lines.push(
      `${pad(col.name, nameWidth)}  ${pad(col.type, typeWidth)}  ${String(col.nullCount).padStart(5)}  ${String(col.distinctCount).padStart(8)}  ${sample}`,
    );
  }
  return lines.join("\n");
}

export interface DescribedColumn {
  name: string;
  type: ColumnInfo["type"];
  stats: ColumnStats;
}

/** `describe()` paired with each column's inferred type. */
export function describeWithTypes(parsed: ParsedCsv): DescribedColumn[] {
  const schema = inferSchema(parsed);
  return describe(parsed).map((d, i) => ({
    name: d.name,
    type: schema[i]?.type ?? "text",
    stats: d.stats,
  }));
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Sorted numeric values of a column, for the distribution sparkline. */
function numericColumnValues(parsed: ParsedCsv, name: string): number[] {
  const idx = parsed.headers.indexOf(name);
  if (idx === -1) return [];
  return parsed.rows
    .map((row) => Number((row[idx] ?? "").trim().replace(/,/g, "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

export function formatDescribeText(parsed: ParsedCsv): string {
  const described = describeWithTypes(parsed);
  const lines = [
    `${parsed.rows.length} ${parsed.rows.length === 1 ? "row" : "rows"}, ${described.length} ${described.length === 1 ? "column" : "columns"}`,
  ];
  for (const { name, type, stats } of described) {
    lines.push(`\n${name} (${type})`);
    if (stats.kind === "numeric" && type === "date") {
      // Epoch sums/stddevs are meaningless for dates: show the range.
      lines.push(
        `  values: ${stats.count}, nulls: ${stats.nullCount}, distinct: ${stats.distinctCount}`,
      );
      lines.push(
        `  range: ${formatDate(stats.min)} to ${formatDate(stats.max)}, median: ${formatDate(stats.median)}`,
      );
      continue;
    }
    if (stats.kind === "numeric") {
      lines.push(
        `  values: ${stats.count}, nulls: ${stats.nullCount}, distinct: ${stats.distinctCount}`,
      );
      lines.push(
        `  min: ${formatNumber(stats.min)}, max: ${formatNumber(stats.max)}, mean: ${formatNumber(stats.mean)}, median: ${formatNumber(stats.median)}, stddev: ${formatNumber(stats.stddev)}`,
      );
      // One-line shape of the distribution: sorted values as a
      // sparkline, so skew and clustering are visible at a glance.
      const values = numericColumnValues(parsed, name);
      if (values.length > 1) {
        lines.push(`  distribution: ${sparkline(values)}`);
      }
      continue;
    }
    lines.push(
      `  values: ${stats.count}, nulls: ${stats.nullCount}, distinct: ${stats.distinctCount}`,
    );
    if (stats.top.length === 0) {
      lines.push("  no values");
    } else {
      for (const { value, count } of stats.top) {
        lines.push(`  ${value} (${count})`);
      }
    }
  }
  return lines.join("\n");
}

/** Human-readable rendering of a data-quality profile. */
export function formatProfileText(parsed: ParsedCsv): string {
  const profile: SheetProfile = profileSheet(parsed);
  const lines = [
    `${profile.rows} ${profile.rows === 1 ? "row" : "rows"}, ${profile.columnCount} ${profile.columnCount === 1 ? "column" : "columns"}`,
  ];
  if (profile.warnings.length === 0) {
    lines.push("No quality issues found.");
  } else {
    lines.push("\nWarnings:");
    for (const warning of profile.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  for (const col of profile.columns) {
    lines.push(`\n${col.name} (${col.type})`);
    lines.push(
      `  nulls: ${col.nullCount} (${Math.round(col.nullRate * 100)}%), distinct: ${col.distinctCount}`,
    );
    if (col.constant) lines.push("  constant: a single distinct value");
    if (col.whitespaceCells > 0) {
      lines.push(
        `  whitespace: ${col.whitespaceCells} ${col.whitespaceCells === 1 ? "cell" : "cells"} with leading/trailing whitespace`,
      );
    }
    if (col.outliers) {
      lines.push(
        `  outliers: ${col.outliers.count} outside [${col.outliers.lowBound}, ${col.outliers.highBound}] (seen ${col.outliers.low} to ${col.outliers.high})`,
      );
    }
  }
  return lines.join("\n");
}

export interface AskJson {
  question: string;
  answer: string;
  /** Structured result, or null when the engine abstained. */
  result: QueryResult | null;
  /** Sheet the answer came from, when the input was a workbook. */
  sheet?: string;
}

export function askJson(question: string, parsed: ParsedCsv): AskJson {
  const parsedQuestion = parseQuestion(question, parsed);
  if (!parsedQuestion.ok) {
    return {
      question,
      answer: composeAbstention(
        parsedQuestion.reason,
        inferSchema(parsed).map((c) => c.name),
      ),
      result: null,
    };
  }
  const result = executeQuery(parsedQuestion.query, parsed);
  return { question, answer: composeAnswer(result, parsed), result };
}

/** `ask --json` against a workbook: the sheet is part of the output. */
export function askWorkbookJson(
  question: string,
  workbook: Workbook,
  sheetName?: string,
): AskJson {
  const { sheet, answer, result } = askWorkbookDetailed(question, workbook, sheetName);
  return { question, answer, result, sheet: sheet ?? undefined };
}

function runSheets(args: ParsedArgs, out: CliOutput): number {
  const workbook = loadWorkbook(args.file!);
  const lines = listSheets(workbook).map((name) => {
    const rows = workbook.sheets.get(name)!.rows.length;
    return `${name} (${rows} ${rows === 1 ? "row" : "rows"})`;
  });
  out.stdout(lines.join("\n") + "\n");
  return 0;
}

function runColumns(args: ParsedArgs, out: CliOutput): number {
  const parsed = resolveSheet(loadWorkbook(args.file!), args.sheet);
  out.stdout(
    (args.json
      ? JSON.stringify(inferSchema(parsed), null, 2)
      : formatColumnsText(parsed)) + "\n",
  );
  return 0;
}

function runDescribe(args: ParsedArgs, out: CliOutput): number {
  const parsed = resolveSheet(loadWorkbook(args.file!), args.sheet);
  out.stdout(
    (args.json
      ? JSON.stringify(describeWithTypes(parsed), null, 2)
      : formatDescribeText(parsed)) + "\n",
  );
  return 0;
}

function runProfile(args: ParsedArgs, out: CliOutput): number {
  const parsed = resolveSheet(loadWorkbook(args.file!), args.sheet);
  out.stdout(
    (args.json
      ? JSON.stringify(profileSheet(parsed), null, 2)
      : formatProfileText(parsed)) + "\n",
  );
  return 0;
}

function runAsk(args: ParsedArgs, out: CliOutput): number {
  const workbook = loadWorkbook(args.file!);
  const question = args.question!;
  if (args.json) {
    out.stdout(JSON.stringify(askWorkbookJson(question, workbook, args.sheet), null, 2) + "\n");
    return 0;
  }
  out.stdout(askWorkbook(question, workbook, args.sheet).answer + "\n");
  return 0;
}

function runChart(args: ParsedArgs, out: CliOutput): number {
  const workbook = loadWorkbook(args.file!);
  const question = args.question!;
  const { answer, result } = askWorkbookDetailed(question, workbook, args.sheet);
  out.stdout(answer + "\n");
  const chart = result ? renderResultChart(result) : null;
  if (chart === null) {
    out.stdout(
      result
        ? "(No chart for this answer — try a group-by question like \"total revenue by region\".)\n"
        : "",
    );
    return 0;
  }
  out.stdout(`\n${chart}\n`);
  if (args.svg !== undefined) {
    const svg = renderResultChartSvg(result!, { title: question });
    try {
      writeFileSync(args.svg, svg + "\n", "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
      throw new CliError(`Cannot write SVG file: ${args.svg} (${code})`);
    }
    out.stdout(`Wrote ${args.svg}\n`);
  }
  return 0;
}

/**
 * Run the CLI on argv (without node/script entries). Returns the
 * process exit code; all output goes through `out`.
 */
export async function runCli(
  argv: string[],
  out: CliOutput = DEFAULT_OUTPUT,
): Promise<number> {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case "help":
        out.stdout(
          args.helpFor ? COMMAND_HELP[args.helpFor] : USAGE,
        );
        return 0;
      case "version":
        out.stdout(`sheet ${VERSION}\n`);
        return 0;
      case "columns":
        return runColumns(args, out);
      case "describe":
        return runDescribe(args, out);
      case "profile":
        return runProfile(args, out);
      case "ask":
        return runAsk(args, out);
      case "chart":
        return runChart(args, out);
      case "sheets":
        return runSheets(args, out);
    }
  } catch (err) {
    if (err instanceof CliError) {
      out.stderr(`${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

// Process entrypoint: only when invoked directly as `sheet` / `tsx src/cli.ts`.
const invoked = process.argv[1] ?? "";
if (invoked.endsWith("cli.ts") || invoked.endsWith("cli.js")) {
  process.exitCode = await runCli(process.argv.slice(2));
}
