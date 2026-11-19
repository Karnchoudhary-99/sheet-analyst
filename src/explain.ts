/**
 * Question explanation: show the user exactly how a plain-English
 * question was understood, before (or instead of) answering it.
 *
 * `sheet explain` is a transparency feature: when an answer looks
 * wrong, the explanation shows whether the parser heard the question
 * the user meant — which column, which operation, which group-by,
 * which filters — instead of leaving the user to guess. It never
 * executes the query, so explaining is free of side effects and
 * always fast.
 */

import type { ParsedCsv } from "./csv.js";
import { parseQuestion, type Filter, type ParseResult, type Query } from "./query.js";
import { inferSchema } from "./schema.js";

export type ExplainResult = ParseResult;

export function explainQuestion(question: string, parsed: ParsedCsv): ExplainResult {
  return parseQuestion(question, parsed);
}

const OP_LABEL: Record<string, string> = {
  sum: "total",
  mean: "average",
  median: "median",
  min: "minimum",
  max: "maximum",
  count: "count",
};

function describeFilter(filter: Filter): string {
  return `${filter.column} ${filter.op} ${filter.value}`;
}

function describeFilters(filters: Filter[]): string {
  return filters.length === 0 ? "none" : filters.map(describeFilter).join(", ");
}

/**
 * One line per fact about the parsed query: what it computes, how it
 * groups, what it filters, how many rows it ranks. The first line is
 * a plain-English summary; the rest are labelled details.
 */
export function describeQuery(query: Query): string[] {
  switch (query.kind) {
    case "aggregate":
      return [
        `${OP_LABEL[query.op] ?? query.op} of ${query.column}`,
        `operation: ${query.op}`,
        `column: ${query.column}`,
        `filters: ${describeFilters(query.filters)}`,
      ];
    case "count":
      return [
        "count of matching rows",
        "operation: count",
        `filters: ${describeFilters(query.filters)}`,
      ];
    case "group": {
      const bucket = query.bucket ? `, bucketed by ${query.bucket}` : "";
      const what = query.column
        ? `${OP_LABEL[query.op] ?? query.op} of ${query.column}`
        : "count";
      return [
        `${what}, grouped by ${query.groupBy}${bucket}`,
        `operation: ${query.op}`,
        ...(query.column ? [`column: ${query.column}`] : []),
        `group by: ${query.groupBy}`,
        ...(query.bucket ? [`time bucket: ${query.bucket}`] : []),
        `filters: ${describeFilters(query.filters)}`,
      ];
    }
    case "top": {
      const bucket = query.bucket ? `, bucketed by ${query.bucket}` : "";
      const grouped = query.groupBy ? `, grouped by ${query.groupBy}${bucket}` : "";
      return [
        `top ${query.limit} ${query.direction} by ${query.column}${grouped}`,
        `operation: rank by ${query.column}`,
        `limit: ${query.limit} (${query.direction})`,
        ...(query.groupBy ? [`group by: ${query.groupBy}`] : []),
        ...(query.bucket ? [`time bucket: ${query.bucket}`] : []),
        `filters: ${describeFilters(query.filters)}`,
      ];
    }
    case "rows":
      return [
        `matching rows (first ${query.limit})`,
        "operation: list rows",
        `limit: ${query.limit}`,
        `filters: ${describeFilters(query.filters)}`,
      ];
  }
}

/**
 * Human-readable explanation of a parsed question. On an abstention
 * the reason is shown with the columns available, so the user can
 * rephrase — the same wording the answer composer uses, minus the
 * "I can't answer that" framing.
 */
export function formatExplainText(
  question: string,
  result: ExplainResult,
  parsed: ParsedCsv,
): string {
  if (!result.ok) {
    const columns = inferSchema(parsed).map((c) => c.name);
    const available =
      columns.length > 0 ? `\nColumns available: ${columns.join(", ")}.` : "";
    return `Question: "${question}"\nI could not understand this question: ${result.reason}.${available}`;
  }
  const lines = describeQuery(result.query);
  return `Question: "${question}"\nUnderstood as: ${lines[0]}\n${lines
    .slice(1)
    .map((l) => `  ${l}`)
    .join("\n")}`;
}
