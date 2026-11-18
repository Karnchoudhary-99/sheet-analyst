/**
 * Answer composer: turn a {@link QueryResult} into a short, cited,
 * human-readable answer, and turn a parser abstention into a plain
 * "I can't answer that" with the reason and the columns available.
 *
 * The composer never invents numbers: every figure comes from the
 * result, and a null aggregate is reported as "no usable values"
 * instead of being silently rendered as zero.
 */

import type { ParsedCsv } from "./csv.js";
import { executeQuery, type QueryResult } from "./engine.js";
import { parseQuestion } from "./query.js";
import { inferSchema } from "./schema.js";

/** Thousands separators, up to 2 decimals, trailing zeros trimmed. */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

function composeScalar(result: Extract<QueryResult, { kind: "scalar" }>): string {
  if (result.label === "count") {
    if (result.value === 0) return "No rows match.";
    if (result.value === 1) return "There is 1 matching row.";
    return `There are ${formatNumber(result.value ?? 0)} matching rows.`;
  }
  if (result.value === null) {
    return (
      `I could not compute the ${result.label} — the column has no usable ` +
      `values in the ${result.rowsMatched} matching ${plural(result.rowsMatched, "row")}.`
    );
  }
  const label = result.label.charAt(0).toUpperCase() + result.label.slice(1);
  return `${label} is ${formatNumber(result.value)} (across ${result.rowsMatched} ${plural(result.rowsMatched, "row")}).`;
}

function composeGroups(result: Extract<QueryResult, { kind: "groups" }>): string {
  if (result.groups.length === 0) return "No rows match.";
  const what = result.column
    ? `${result.op} ${result.column}`
    : "count";
  const scope =
    result.limitedTo !== undefined && result.totalGroups !== undefined
      ? `Top ${result.limitedTo} of ${result.totalGroups} groups`
      : `${what.charAt(0).toUpperCase() + what.slice(1)} by ${result.groupBy}`;
  const lines = result.groups.map(
    (g) => `- ${g.key}: ${formatNumber(g.value)} (${g.count} ${plural(g.count, "row")})`,
  );
  return `${scope}:\n${lines.join("\n")}`;
}

function composeRows(result: Extract<QueryResult, { kind: "rows" }>): string {
  if (result.totalMatched === 0) return "No rows match.";
  const scope =
    result.limitedTo !== undefined
      ? `Showing ${result.rows.length} of ${result.totalMatched} matching rows`
      : `${result.totalMatched} matching ${plural(result.totalMatched, "row")}`;
  const header = `| ${result.headers.join(" | ")} |`;
  const divider = `| ${result.headers.map(() => "---").join(" | ")} |`;
  const body = result.rows.map(
    (row) => `| ${result.headers.map((h) => row[h] ?? "").join(" | ")} |`,
  );
  return `${scope}:\n${header}\n${divider}\n${body.join("\n")}`;
}

export function composeAnswer(result: QueryResult): string {
  switch (result.kind) {
    case "scalar":
      return composeScalar(result);
    case "groups":
      return composeGroups(result);
    case "rows":
      return composeRows(result);
  }
}

export function composeAbstention(reason: string, columns: string[]): string {
  const available =
    columns.length > 0 ? ` Columns available: ${columns.join(", ")}.` : "";
  return `I can't answer that from this data: ${reason}.${available}`;
}

/**
 * Ask a question about a sheet in one call: parse, execute, compose.
 * Returns the answer text — or an honest abstention when the question
 * cannot be understood from this sheet.
 */
export function answerQuestion(question: string, parsed: ParsedCsv): string {
  const parsedQuestion = parseQuestion(question, parsed);
  if (!parsedQuestion.ok) {
    return composeAbstention(
      parsedQuestion.reason,
      inferSchema(parsed).map((c) => c.name),
    );
  }
  return composeAnswer(executeQuery(parsedQuestion.query, parsed));
}
