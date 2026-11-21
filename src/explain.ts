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
import { ordinal } from "./stats.js";

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

function describeFilters(filters: Filter[], orGroups?: Filter[][]): string {
  const plain = filters.map(describeFilter);
  const groups = (orGroups ?? []).map((g) => {
    const inner = g.map(describeFilter).join(" and ");
    return g.length > 1 ? `(${inner})` : inner;
  });
  const parts = [...plain];
  if (groups.length > 0) {
    // Parenthesise the OR set when it sits next to plain filters,
    // so the precedence is visible; on its own it reads plainly.
    parts.push(
      plain.length === 0
        ? groups.join(" or ")
        : groups.length > 1
          ? `(${groups.join(" or ")})`
          : groups[0]!,
    );
  }
  return parts.length === 0 ? "none" : parts.join(", ");
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
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "count":
      return [
        "count of matching rows",
        "operation: count",
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "group": {
      const bucket = query.bucket ? `, bucketed by ${query.bucket}` : "";
      const groupedBy = query.groupBy.join(" and ");
      const what = query.column
        ? `${OP_LABEL[query.op] ?? query.op} of ${query.column}`
        : "count";
      return [
        `${what}, grouped by ${groupedBy}${bucket}`,
        `operation: ${query.op}`,
        ...(query.column ? [`column: ${query.column}`] : []),
        `group by: ${query.groupBy.join(", ")}`,
        ...(query.bucket ? [`time bucket: ${query.bucket}`] : []),
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "top": {
      const bucket = query.bucket ? `, bucketed by ${query.bucket}` : "";
      const grouped = query.groupBy
        ? `, grouped by ${query.groupBy.join(" and ")}${bucket}`
        : "";
      // "top 3 lowest by revenue" reads as a contradiction; the
      // low end of a ranking is a bottom-N.
      const rankWord = query.direction === "lowest" ? "bottom" : "top";
      return [
        `${rankWord} ${query.limit} by ${query.column}${grouped}`,
        `operation: rank by ${query.column}`,
        `limit: ${query.limit} (${query.direction})`,
        ...(query.groupBy ? [`group by: ${query.groupBy.join(", ")}`] : []),
        ...(query.bucket ? [`time bucket: ${query.bucket}`] : []),
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "rows": {
      const sorted = query.sort
        ? `, sorted by ${query.sort.column} (${query.sort.direction === "desc" ? "descending" : "ascending"})`
        : "";
      return [
        `matching rows (first ${query.limit})${sorted}`,
        "operation: list rows",
        `limit: ${query.limit}`,
        ...(query.sort
          ? [
              `sorted by: ${query.sort.column} (${query.sort.direction === "desc" ? "descending" : "ascending"})`,
            ]
          : []),
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "correlation":
      return [
        `correlation between ${query.columnA} and ${query.columnB}`,
        "operation: correlation",
        `column A: ${query.columnA}`,
        `column B: ${query.columnB}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "comparison": {
      const what = query.column
        ? `${OP_LABEL[query.op] ?? query.op} of ${query.column}`
        : "row count";
      return [
        `compare ${what}: ${query.periodA.label} vs ${query.periodB.label}`,
        `operation: ${query.op}`,
        ...(query.column ? [`column: ${query.column}`] : []),
        `date column: ${query.dateColumn}`,
        `period A: ${query.periodA.label}`,
        `period B: ${query.periodB.label}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "share": {
      const what = query.column
        ? `share of total ${query.column}`
        : "share of rows";
      return [
        `${what} for ${describeFilters(query.filters, query.orGroups)}`,
        "operation: share",
        ...(query.column ? [`column: ${query.column}`] : []),
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "distinct":
      return [
        `distinct values of ${query.column}`,
        "operation: list distinct values",
        `column: ${query.column}`,
        `limit: ${query.limit}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "mode":
      return [
        `most common value of ${query.column}`,
        "operation: mode",
        `column: ${query.column}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "distribution":
      return [
        `distribution of ${query.column}`,
        "operation: histogram",
        `column: ${query.column}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "distinctCount":
      return [
        `distinct count of ${query.column}`,
        "operation: count distinct values",
        `column: ${query.column}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "percentile":
      return [
        `${ordinal(query.p)} percentile of ${query.column}`,
        "operation: percentile",
        `column: ${query.column}`,
        `percentile: ${query.p}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "rank":
      return [
        `${ordinal(query.n)} ${query.direction} value of ${query.column}`,
        "operation: rank",
        `column: ${query.column}`,
        `rank: ${query.n}`,
        `direction: ${query.direction}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "trend": {
      const what = `${OP_LABEL[query.op] ?? query.op} ${query.column}`;
      return [
        `trend of ${what} by ${query.bucket}`,
        "operation: trend",
        `column: ${query.column}`,
        `date column: ${query.dateColumn}`,
        `time bucket: ${query.bucket}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "aboveBelow":
      return [
        `rows with ${query.column} ${query.direction} the ${query.baseline}`,
        `operation: ${query.direction} ${query.baseline}`,
        `column: ${query.column}`,
        `baseline: ${query.baseline}`,
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    case "missing": {
      const what = query.listRows
        ? `rows missing ${query.column}`
        : query.column
          ? `missing values in ${query.column}`
          : "missing values by column";
      return [
        what,
        "operation: missing values",
        ...(query.column ? [`column: ${query.column}`] : []),
        ...(query.listRows ? ["list rows: true"] : []),
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "outliers": {
      const what = query.listRows
        ? `rows that are outliers in ${query.column}`
        : query.column
          ? `outliers in ${query.column}`
          : "outliers by column";
      return [
        what,
        "operation: outliers",
        ...(query.column ? [`column: ${query.column}`] : []),
        ...(query.listRows ? ["list rows: true"] : []),
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
    case "duplicates": {
      const what = query.listRows
        ? query.column
          ? `rows that are duplicates in ${query.column}`
          : "rows that duplicate an earlier row"
        : query.column
          ? `duplicates in ${query.column}`
          : "duplicates by column";
      return [
        what,
        "operation: duplicates",
        ...(query.column ? [`column: ${query.column}`] : []),
        ...(query.listRows ? ["list rows: true"] : []),
        `filters: ${describeFilters(query.filters, query.orGroups)}`,
      ];
    }
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
    // Several parser reasons already name the columns ("… — columns
    // are: a, b"); don't list them a second time.
    const available =
      !result.reason.includes("columns are:") && columns.length > 0
        ? `\nColumns available: ${columns.join(", ")}.`
        : "";
    return `Question: "${question}"\nI could not understand this question: ${result.reason}.${available}`;
  }
  const lines = describeQuery(result.query);
  return `Question: "${question}"\nUnderstood as: ${lines[0]}\n${lines
    .slice(1)
    .map((l) => `  ${l}`)
    .join("\n")}`;
}
