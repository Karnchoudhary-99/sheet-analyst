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
  // Say so when some matching rows had no usable value, so a mean
  // over 2 values is never presented as a mean over 3 rows.
  const coverage =
    result.valuesUsed < result.rowsMatched
      ? `, ${result.valuesUsed} of ${result.rowsMatched} had a value`
      : "";
  return `${label} is ${formatNumber(result.value)} (across ${result.rowsMatched} ${plural(result.rowsMatched, "row")}${coverage}).`;
}

const BUCKET_PLURAL: Record<string, string> = {
  day: "days",
  week: "weeks",
  month: "months",
  quarter: "quarters",
  year: "years",
};

function composeGroups(result: Extract<QueryResult, { kind: "groups" }>): string {
  if (result.groups.length === 0) return "No rows match.";
  const opLabel: Record<string, string> = {
    sum: "total",
    mean: "average",
    median: "median",
    min: "minimum",
    max: "maximum",
    count: "count",
  };
  const what = result.column
    ? `${opLabel[result.op] ?? result.op} ${result.column}`
    : "count";
  // A time-bucketed answer groups by period, not by the raw date
  // column: "Total revenue by month", "Top 2 of 4 months".
  const by = result.bucket ? `by ${result.bucket}` : `by ${result.groupBy}`;
  const scope =
    result.limitedTo !== undefined && result.totalGroups !== undefined
      ? `Top ${result.limitedTo} of ${result.totalGroups} ${result.bucket ? BUCKET_PLURAL[result.bucket] : "groups"}`
      : `${what.charAt(0).toUpperCase() + what.slice(1)} ${by}`;
  const lines = result.groups.map(
    (g) => `- ${g.key}: ${formatNumber(g.value)} (${g.count} ${plural(g.count, "row")})`,
  );
  return `${scope}:\n${lines.join("\n")}`;
}

function composeCorrelation(
  result: Extract<QueryResult, { kind: "correlation" }>,
): string {
  const { columnA, columnB, value, pairs, rowsMatched } = result;
  if (value === null) {
    if (pairs < 2) {
      return (
        `I could not compute the correlation between ${columnA} and ${columnB} — ` +
        `only ${pairs} of the ${rowsMatched} matching ${plural(rowsMatched, "row")} ` +
        `${pairs === 1 ? "has" : "have"} values in both columns.`
      );
    }
    return (
      `I could not compute the correlation between ${columnA} and ${columnB} — ` +
      `one of the columns is constant in the matching rows, so there is no ` +
      `variation to correlate.`
    );
  }
  // -0.00 reads as a typo; round tiny values to a clean 0.00.
  const display = Math.abs(value) < 0.005 ? 0 : value;
  const abs = Math.abs(value);
  const strength =
    abs >= 0.7 ? "strong" : abs >= 0.4 ? "moderate" : abs >= 0.1 ? "weak" : "negligible";
  const paired = `${pairs} paired ${plural(pairs, "row")}`;
  if (strength === "negligible") {
    return (
      `The correlation between ${columnA} and ${columnB} is ${display.toFixed(2)} ` +
      `(negligible — essentially no linear relationship) across ${paired}.`
    );
  }
  const direction = value >= 0 ? "positive" : "negative";
  return (
    `The correlation between ${columnA} and ${columnB} is ${display.toFixed(2)} ` +
    `(${strength} ${direction}) across ${paired}.`
  );
}

function composeComparison(
  result: Extract<QueryResult, { kind: "comparison" }>,
): string {
  const opLabel: Record<string, string> = {
    sum: "total",
    mean: "average",
    median: "median",
    min: "minimum",
    max: "maximum",
    count: "count",
  };
  const what = result.column
    ? `${opLabel[result.op] ?? result.op} ${result.column}`
    : "row count";
  const label = what.charAt(0).toUpperCase() + what.slice(1);
  const a = result.periodA;
  const b = result.periodB;
  // A period with no usable values cannot be compared — say which
  // one, and whether it had no rows at all or only unusable values.
  if (a.value === null || b.value === null) {
    const missing = a.value === null ? a : b;
    const cause =
      missing.rows === 0
        ? "has no rows"
        : `has ${missing.rows} ${missing.rows === 1 ? "row" : "rows"} but none with a usable value`;
    return (
      `I could not compare the ${what} — ${missing.label} ${cause}, ` +
      `so there is nothing to compare against.`
    );
  }
  const signed = (n: number): string =>
    `${n >= 0 ? "+" : ""}${formatNumber(n)}`;
  // Flag a period where some rows had no usable value, so a mean
  // over 2 values is never presented as a mean over 3 rows.
  const coverage = [a, b]
    .filter((p) => p.valuesUsed < p.rows)
    .map((p) => `${p.valuesUsed} of ${p.rows} had a value in ${p.label}`)
    .join("; ");
  const coverageNote = coverage ? ` (${coverage})` : "";
  const delta = result.delta!;
  if (delta === 0) {
    return `${label} was unchanged at ${formatNumber(a.value)} in both ${a.label} and ${b.label}.${coverageNote}`;
  }
  const verb = delta > 0 ? "grew" : "fell";
  const pct =
    result.pctChange === null
      ? ""
      : `, ${signed(result.pctChange)}%`;
  const pctNote =
    result.pctChange === null
      ? ` No percent change is possible — the ${a.label} baseline was 0.`
      : "";
  return (
    `${label} ${verb} from ${formatNumber(a.value)} in ${a.label} ` +
    `to ${formatNumber(b.value)} in ${b.label} ` +
    `(${signed(delta)}${pct}).${pctNote}${coverageNote}`
  );
}

function composeShare(result: Extract<QueryResult, { kind: "share" }>): string {
  // Filters are described plainly here: "region is North".
  const filterDesc = result.filters
    .map((f) => `${f.column} is ${f.value}`)
    .join(" and ");
  // A share needs a non-zero total to divide by; a zero total means
  // the whole sheet has nothing to share out, not a 0% share.
  if (result.share === null) {
    if (result.column === null) {
      return "The sheet has no rows, so there is no share to compute.";
    }
    return (
      `I could not compute the share of total ${result.column} — ` +
      `the total is 0, so there is nothing to share out.`
    );
  }
  const pct = formatNumber(result.share * 100);
  if (result.column === null) {
    return (
      `${result.subsetRows} of ${result.totalRows} ${plural(result.totalRows, "row")} ` +
      `(${pct}%) match ${filterDesc}.`
    );
  }
  const what = filterDesc.charAt(0).toUpperCase() + filterDesc.slice(1);
  // Flag a subset where some rows had no usable value, so a share
  // over 2 values is never presented as a share over 3 rows.
  const coverage =
    result.valuesUsed < result.subsetRows
      ? `, ${result.valuesUsed} of ${result.subsetRows} had a value`
      : "";
  return (
    `${what} accounts for ${pct}% of total ${result.column} ` +
    `(${formatNumber(result.subsetValue)} of ${formatNumber(result.totalValue)}, ` +
    `from ${result.subsetRows} of ${result.totalRows} ${plural(result.totalRows, "row")}${coverage}).`
  );
}

function composeRows(
  result: Extract<QueryResult, { kind: "rows" }>,
  parsed?: ParsedCsv,
): string {
  if (result.totalMatched === 0) return "No rows match.";
  const scope =
    result.limitedTo !== undefined
      ? `Showing ${result.rows.length} of ${result.totalMatched} matching rows`
      : `${result.totalMatched} matching ${plural(result.totalMatched, "row")}`;
  const header = `| ${result.headers.join(" | ")} |`;
  const divider = `| ${result.headers.map(() => "---").join(" | ")} |`;
  // Row cells are raw CSV text; format numeric columns the same way
  // scalar answers are formatted, so "98000" reads as "98,000".
  // Without the sheet we cannot know the column types, so the cells
  // stay raw — callers with the sheet pass it in.
  const numeric = new Set<string>();
  if (parsed) {
    for (const c of inferSchema(parsed)) {
      if (c.type === "integer" || c.type === "number") numeric.add(c.name);
    }
  }
  const cell = (h: string, raw: string): string => {
    if (!numeric.has(h) || raw.trim() === "") return raw;
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? formatNumber(n) : raw;
  };
  const body = result.rows.map(
    (row) => `| ${result.headers.map((h) => cell(h, row[h] ?? "")).join(" | ")} |`,
  );
  return `${scope}:\n${header}\n${divider}\n${body.join("\n")}`;
}

export function composeAnswer(result: QueryResult, parsed?: ParsedCsv): string {
  switch (result.kind) {
    case "scalar":
      return composeScalar(result);
    case "groups":
      return composeGroups(result);
    case "rows":
      return composeRows(result, parsed);
    case "correlation":
      return composeCorrelation(result);
    case "comparison":
      return composeComparison(result);
    case "share":
      return composeShare(result);
  }
}

export function composeAbstention(reason: string, columns: string[]): string {
  // Several parser reasons already name the columns ("… — columns are:
  // a, b"); don't list them a second time.
  const alreadyListsColumns = reason.includes("columns are:");
  const available =
    !alreadyListsColumns && columns.length > 0
      ? ` Columns available: ${columns.join(", ")}.`
      : "";
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
  return composeAnswer(executeQuery(parsedQuestion.query, parsed), parsed);
}
