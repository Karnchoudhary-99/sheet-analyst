#!/usr/bin/env node
/**
 * CLI: `sheet <command> <file.csv> [args]`
 *
 *   sheet columns <file> [--json]   list columns with inferred types
 *   sheet describe <file> [--json]  per-column descriptive statistics
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

import { readFileSync } from "node:fs";
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
import { describe, type ColumnStats } from "./stats.js";

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
  sheet ask <file.csv> <question> [--json]
                                        answer a plain-English question
  sheet --help                         show this help
  sheet --version                      show the version

Options:
  --json    machine-readable JSON instead of human-readable text
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
  ask: `Usage: sheet ask <file.csv> <question> [--json]

Ask a plain-English question about the sheet and print the answer
computed from the data — or an honest "I can't answer that" when the
question cannot be understood from this sheet. The question may be
several words; quoting it is optional. With --json the output is
{ question, answer, result } where result is the structured query
result, or null when the engine abstained.
`,
};

export type CommandName = "columns" | "describe" | "ask";

export interface ParsedArgs {
  command: CommandName | "help" | "version";
  /** Command the help was requested for, when `command` is "help". */
  helpFor?: CommandName;
  file?: string;
  /** The question words for `ask`, joined with spaces. */
  question?: string;
  json: boolean;
}

const COMMANDS = new Set(["columns", "describe", "ask"]);

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

  // Split off flags (--json, --help) from positionals. A flag may
  // appear anywhere after the command; anything else is positional.
  const positionals: string[] = [];
  let json = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", helpFor: command, json: false };
    } else if (arg.startsWith("-")) {
      throw new CliError(`Unknown flag: ${arg}`, 2);
    } else {
      positionals.push(arg);
    }
  }

  const [file, ...questionWords] = positionals;
  if (file === undefined) {
    throw new CliError(
      `Missing file argument.\n${COMMAND_HELP[command]}`,
      2,
    );
  }
  if (command === "ask") {
    if (questionWords.length === 0) {
      throw new CliError(
        `Missing question.\n${COMMAND_HELP[command]}`,
        2,
      );
    }
    return { command, file, question: questionWords.join(" "), json };
  }
  if (questionWords.length > 0) {
    throw new CliError(
      `Unexpected argument: ${questionWords[0]}\n${COMMAND_HELP[command]}`,
      2,
    );
  }
  return { command, file, json };
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

export interface AskJson {
  question: string;
  answer: string;
  /** Structured result, or null when the engine abstained. */
  result: QueryResult | null;
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
  return { question, answer: composeAnswer(result), result };
}

function runColumns(args: ParsedArgs, out: CliOutput): number {
  const parsed = loadSheet(args.file!);
  out.stdout(
    (args.json
      ? JSON.stringify(inferSchema(parsed), null, 2)
      : formatColumnsText(parsed)) + "\n",
  );
  return 0;
}

function runDescribe(args: ParsedArgs, out: CliOutput): number {
  const parsed = loadSheet(args.file!);
  out.stdout(
    (args.json
      ? JSON.stringify(describeWithTypes(parsed), null, 2)
      : formatDescribeText(parsed)) + "\n",
  );
  return 0;
}

function runAsk(args: ParsedArgs, out: CliOutput): number {
  const parsed = loadSheet(args.file!);
  const question = args.question!;
  if (args.json) {
    out.stdout(JSON.stringify(askJson(question, parsed), null, 2) + "\n");
    return 0;
  }
  out.stdout(answerQuestion(question, parsed) + "\n");
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
      case "ask":
        return runAsk(args, out);
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
