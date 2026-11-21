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
import { parseQuestion, type Filter } from "./query.js";
import { inferSchema } from "./schema.js";
import { ordinal } from "./stats.js";
import { renderHistogram } from "./charts.js";

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

function composeRank(result: Extract<QueryResult, { kind: "rank" }>): string {
  const label = `The ${ordinal(result.n)} ${result.direction} ${result.column}`;
  if (result.value === null) {
    if (result.totalDistinct === 0) {
      return (
        `I could not find the ${ordinal(result.n)} ${result.direction} ${result.column} — ` +
        `the column has no usable values in the ${result.rowsMatched} matching ${plural(result.rowsMatched, "row")}.`
      );
    }
    return (
      `${label} does not exist — there ${result.totalDistinct === 1 ? "is" : "are"} only ` +
      `${result.totalDistinct} distinct ${result.column} ${plural(result.totalDistinct, "value")} ` +
      `in the ${result.rowsMatched} matching ${plural(result.rowsMatched, "row")}.`
    );
  }
  // Say so when some matching rows had no usable value, so a rank
  // over 4 values is never presented as a rank over 5 rows.
  const coverage =
    result.valuesUsed < result.rowsMatched
      ? `; ${result.valuesUsed} of ${result.rowsMatched} had a value`
      : "";
  return (
    `${label} is ${formatNumber(result.value)} ` +
    `(${result.rowsAtValue} ${plural(result.rowsAtValue, "row")} ${result.rowsAtValue === 1 ? "holds" : "hold"} it, ` +
    `out of ${result.totalDistinct} distinct ${plural(result.totalDistinct, "value")}${coverage}).`
  );
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
  // Multi-column groups name every column: "by region and product".
  const by = result.bucket
    ? `by ${result.bucket}`
    : `by ${result.groupBy.join(" and ")}`;
  const scope =
    result.limitedTo !== undefined && result.totalGroups !== undefined
      ? `${result.direction === "lowest" ? "Bottom" : "Top"} ${result.limitedTo} of ${result.totalGroups} ${result.bucket ? BUCKET_PLURAL[result.bucket] : "groups"}`
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

/** Render one filter in words: "region is North", "revenue is greater than 100". */
function describeFilter(filter: Filter): string {
  const opWord: Record<Filter["op"], string> = {
    "=": "is",
    "!=": "is not",
    ">": "is greater than",
    ">=": "is at least",
    "<": "is less than",
    "<=": "is at most",
    contains: "contains",
  };
  return `${filter.column} ${opWord[filter.op]} ${filter.value}`;
}

function composeShare(result: Extract<QueryResult, { kind: "share" }>): string {
  // Filters are described plainly here, with their operators:
  // "region is North and revenue is greater than 100".
  const filterDesc = result.filters.map(describeFilter).join(" and ");
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

function composeValues(result: Extract<QueryResult, { kind: "values" }>): string {
  if (result.values.length === 0) return "No rows match.";
  const scope =
    result.limitedTo !== undefined
      ? `Distinct ${result.column} (${result.totalDistinct} values, showing ${result.limitedTo})`
      : `Distinct ${result.column} (${result.totalDistinct} ${plural(result.totalDistinct, "value")})`;
  const lines = result.values.map(
    (v) => `- ${v.value}: ${v.count} ${plural(v.count, "row")}`,
  );
  return `${scope}:\n${lines.join("\n")}`;
}

function composeDistribution(result: Extract<QueryResult, { kind: "distribution" }>): string {
  if (result.valuesUsed === 0) {
    return (
      `I could not show the distribution of ${result.column} — ` +
      `none of the ${result.rowsMatched} matching ${plural(result.rowsMatched, "row")} ` +
      `has a usable value.`
    );
  }
  const header =
    `Distribution of ${result.column} ` +
    `(${result.valuesUsed} ${plural(result.valuesUsed, "value")} across ` +
    `${result.rowsMatched} ${plural(result.rowsMatched, "row")}):`;
  return `${header}\n${renderHistogram(result.bins)}`;
}

function composeMode(result: Extract<QueryResult, { kind: "mode" }>): string {
  if (result.value === null) {
    return (
      `I could not find the most common ${result.column} — the column has no usable ` +
      `values in the ${result.rowsMatched} matching ${plural(result.rowsMatched, "row")}.`
    );
  }
  return (
    `The most common ${result.column} is ${result.value} ` +
    `(${result.count} of ${result.rowsMatched} ${plural(result.rowsMatched, "row")}, ` +
    `out of ${result.totalDistinct} distinct ${plural(result.totalDistinct, "value")}).`
  );
}

function composeTrend(result: Extract<QueryResult, { kind: "trend" }>): string {
  const opLabel: Record<string, string> = {
    sum: "total",
    mean: "average",
    median: "median",
    min: "minimum",
    max: "maximum",
    count: "count",
  };
  const what = `${opLabel[result.op] ?? result.op} ${result.column}`;
  const label = what.charAt(0).toUpperCase() + what.slice(1);
  const fitted = result.periods.filter(
    (
      p,
    ): p is { label: string; value: number; rows: number; valuesUsed: number } =>
      p.value !== null,
  );
  if (result.periods.length === 0) {
    return (
      `I could not compute the trend of ${what} by ${result.bucket} — ` +
      `none of the ${result.rowsMatched} matching ${plural(result.rowsMatched, "row")} ` +
      `has a usable date.`
    );
  }
  if (fitted.length < 2) {
    const only = fitted[0];
    const cause =
      only === undefined
        ? "no period has a usable value"
        : `only ${only.label} has a usable value`;
    return (
      `I could not compute the trend of ${what} by ${result.bucket} — ${cause}, ` +
      `so there is no line to fit.`
    );
  }
  const first = fitted[0];
  const last = fitted[fitted.length - 1];
  const slope = result.slope!;
  const per = `per ${result.bucket}`;
  const span = `${fitted.length} ${BUCKET_PLURAL[result.bucket]}`;
  const range = `from ${formatNumber(first.value)} in ${first.label} to ${formatNumber(last.value)} in ${last.label}`;
  // Periods with no usable value are named, so a gap in the line is
  // visible instead of silently skipped.
  const gaps = result.periods.filter((p) => p.value === null);
  const gapNote =
    gaps.length === 0
      ? ""
      : ` ${gaps.map((p) => p.label).join(", ")} ${gaps.length === 1 ? "has" : "have"} no usable values and ${gaps.length === 1 ? "is" : "are"} not in the trend.`;
  if (result.direction === "flat") {
    return (
      `${label} was roughly flat by ${result.bucket} (about ${formatNumber(Math.abs(slope))} ${per}) ` +
      `across ${span}, ${range}.${gapNote}`
    );
  }
  const verb = result.direction === "up" ? "trended up" : "trended down";
  return (
    `${label} ${verb} by about ${formatNumber(Math.abs(slope))} ${per} ` +
    `over ${span} (${range}).${gapNote}`
  );
}

/**
 * Render a row table (header + divider + one line per row). Shared by
 * the row listing and the above/below-average answer, which both
 * show matching rows — only their scope lines differ.
 */
function renderRowTable(
  headers: string[],
  rows: Record<string, string>[],
  parsed?: ParsedCsv,
): string {
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
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
  const body = rows.map(
    (row) => `| ${headers.map((h) => cell(h, row[h] ?? "")).join(" | ")} |`,
  );
  return `${header}\n${divider}\n${body.join("\n")}`;
}

function composeRows(
  result: Extract<QueryResult, { kind: "rows" }>,
  parsed?: ParsedCsv,
): string {
  if (result.totalMatched === 0) return "No rows match.";
  // A sorted listing says so, so the reader knows the table is not
  // in sheet order (and which end they are looking at).
  const sorted =
    result.sortedBy !== undefined
      ? `, sorted by ${result.sortedBy.column} (${result.sortedBy.direction === "desc" ? "descending" : "ascending"})`
      : "";
  const scope =
    result.limitedTo !== undefined
      ? `Showing ${result.rows.length} of ${result.totalMatched} matching rows${sorted}`
      : `${result.totalMatched} matching ${plural(result.totalMatched, "row")}${sorted}`;
  return `${scope}:\n${renderRowTable(result.headers, result.rows, parsed)}`;
}

function composeMissing(
  result: Extract<QueryResult, { kind: "missing" }>,
  parsed?: ParsedCsv,
): string {
  const pct = (missing: number, total: number): string =>
    total === 0 ? "0%" : `${formatNumber((missing / total) * 100)}%`;
  // The whole-sheet report lists every column, most missing first,
  // so a clean column reads as "0 of N rows missing" instead of
  // being silently absent from the report.
  if (result.column === null) {
    if (result.rowsMatched === 0) return "No rows match.";
    const lines = result.entries.map(
      (e) => `- ${e.column}: ${e.missing} of ${e.total} rows missing (${pct(e.missing, e.total)})`,
    );
    if (result.entries.every((e) => e.missing === 0)) {
      return (
        `No missing values — every column has a value in all ` +
        `${result.rowsMatched} ${plural(result.rowsMatched, "row")}.`
      );
    }
    return `Missing values (${result.rowsMatched} ${plural(result.rowsMatched, "row")}):\n${lines.join("\n")}`;
  }
  const entry = result.entries[0]!;
  if (result.listRows) {
    if (result.totalMatched === 0) {
      return `No rows are missing ${result.column}.`;
    }
    const scope =
      result.limitedTo !== undefined
        ? `Showing ${result.rows.length} of ${result.totalMatched} rows missing ${result.column}`
        : `${result.totalMatched} ${plural(result.totalMatched, "row")} missing ${result.column}`;
    return `${scope}:\n${renderRowTable(result.headers, result.rows, parsed)}`;
  }
  if (entry.missing === 0) {
    return `No rows are missing ${result.column} (0 of ${entry.total} rows).`;
  }
  const verb = entry.missing === 1 ? "is" : "are";
  return (
    `${entry.missing} of ${entry.total} ${plural(entry.total, "row")} ${verb} ` +
    `missing ${result.column} (${pct(entry.missing, entry.total)}).`
  );
}

function composeOutliers(
  result: Extract<QueryResult, { kind: "outliers" }>,
  parsed?: ParsedCsv,
): string {
  const pct = (outliers: number, total: number): string =>
    total === 0 ? "0%" : `${formatNumber((outliers / total) * 100)}%`;
  const seen = (entry: { low: number | null; high: number | null }): string =>
    entry.low === null || entry.high === null
      ? ""
      : entry.low === entry.high
        ? ` (seen ${formatNumber(entry.low)})`
        : ` (seen ${formatNumber(entry.low)} to ${formatNumber(entry.high)})`;
  const fence = (entry: { lowBound: number | null; highBound: number | null }): string =>
    entry.lowBound === null || entry.highBound === null
      ? ""
      : ` outside [${formatNumber(entry.lowBound)}, ${formatNumber(entry.highBound)}]`;
  // The whole-sheet report lists every numeric column, most outliers
  // first, so a clean column reads as "0 outliers" instead of being
  // silently absent from the report.
  if (result.column === null) {
    if (result.rowsMatched === 0) return "No rows match.";
    const lines = result.entries.map((e) => {
      if (e.lowBound === null || e.highBound === null) {
        return `- ${e.column}: not enough values (${e.total} values) to judge outliers`;
      }
      if (e.outliers === 0) {
        return `- ${e.column}: 0 outliers (inside [${formatNumber(e.lowBound)}, ${formatNumber(e.highBound)}])`;
      }
      return `- ${e.column}: ${e.outliers} ${plural(e.outliers, "outlier")}${fence(e)}${seen(e)}`;
    });
    if (result.entries.every((e) => e.outliers === 0 && e.lowBound !== null)) {
      return (
        `No outliers — every numeric value in the ${result.rowsMatched} ` +
        `${plural(result.rowsMatched, "row")} is inside its fence.`
      );
    }
    return `Outliers (${result.rowsMatched} ${plural(result.rowsMatched, "row")}):\n${lines.join("\n")}`;
  }
  const entry = result.entries[0]!;
  if (entry.total === 0) {
    return (
      `I could not find outliers in ${result.column} — none of the ` +
      `${result.rowsMatched} matching ${plural(result.rowsMatched, "row")} has a usable value.`
    );
  }
  if (entry.lowBound === null || entry.highBound === null) {
    return (
      `Too few values to judge outliers in ${result.column} — only ` +
      `${entry.total} of ${result.rowsMatched} ${plural(result.rowsMatched, "row")} ` +
      `${entry.total === 1 ? "has" : "have"} a value (at least 4 needed).`
    );
  }
  if (result.listRows) {
    if (result.totalMatched === 0) {
      return `No rows are outliers in ${result.column}.`;
    }
    const scope =
      result.limitedTo !== undefined
        ? `Showing ${result.rows.length} of ${result.totalMatched} rows that are outliers in ${result.column}`
        : result.totalMatched === 1
          ? `1 row that is an outlier in ${result.column}`
          : `${result.totalMatched} rows that are outliers in ${result.column}`;
    return `${scope}:\n${renderRowTable(result.headers, result.rows, parsed)}`;
  }
  if (entry.outliers === 0) {
    return `No outliers in ${result.column} — every value is inside [${formatNumber(entry.lowBound)}, ${formatNumber(entry.highBound)}].`;
  }
  const verb = entry.outliers === 1 ? "is" : "are";
  const noun = entry.outliers === 1 ? "an outlier" : "outliers";
  return (
    `${entry.outliers} of ${entry.total} ${plural(entry.total, "row")} ${verb} ` +
    `${noun} in ${result.column} (${pct(entry.outliers, entry.total)})${fence(entry)}${seen(entry)}.`
  );
}

function composeDuplicates(
  result: Extract<QueryResult, { kind: "duplicates" }>,
  parsed?: ParsedCsv,
): string {
  const pct = (duplicates: number, total: number): string =>
    total === 0 ? "0%" : `${formatNumber((duplicates / total) * 100)}%`;
  const valueWord = (n: number): string =>
    `${n} ${n === 1 ? "value appears" : "values appear"} more than once`;
  // A single column: a count, or the duplicate rows themselves.
  if (result.column !== null) {
    const entry = result.entries[0]!;
    if (entry.total === 0) {
      return (
        `I could not check duplicates in ${result.column} — none of the ` +
        `${result.rowsMatched} matching ${plural(result.rowsMatched, "row")} has a value.`
      );
    }
    // Flag rows with no value, so a duplicate count over 6 values is
    // never presented as a count over 8 rows.
    const coverage =
      entry.total < result.rowsMatched
        ? ` (${entry.total} of ${result.rowsMatched} had a value)`
        : "";
    if (result.listRows) {
      if (result.totalMatched === 0) {
        return `No rows are duplicates in ${result.column}.`;
      }
      const scope =
        result.limitedTo !== undefined
          ? `Showing ${result.rows.length} of ${result.totalMatched} rows that are duplicates in ${result.column}`
          : result.totalMatched === 1
            ? `1 row that is a duplicate in ${result.column}`
            : `${result.totalMatched} rows that are duplicates in ${result.column}`;
      return `${scope}:\n${renderRowTable(result.headers, result.rows, parsed)}`;
    }
    if (entry.duplicates === 0) {
      return `No duplicates in ${result.column} — every value appears once${coverage}.`;
    }
    const verb = entry.duplicates === 1 ? "is" : "are";
    const noun = entry.duplicates === 1 ? "a duplicate" : "duplicates";
    return (
      `${entry.duplicates} of ${entry.total} ${plural(entry.total, "row")} ${verb} ` +
      `${noun} in ${result.column} (${pct(entry.duplicates, entry.total)}) — ` +
      `${valueWord(entry.valuesWithDuplicates)}${coverage}.`
    );
  }
  // The whole-sheet report: the exact duplicate rows first, then
  // the per-column counts, most duplicates first — so a clean
  // column reads as "0 duplicates" instead of being silently
  // absent from the report.
  if (result.listRows) {
    if (result.totalMatched === 0) {
      return "No rows are exact duplicates of an earlier row.";
    }
    const scope =
      result.limitedTo !== undefined
        ? `Showing ${result.rows.length} of ${result.totalMatched} rows that are exact duplicates of an earlier row`
        : result.totalMatched === 1
          ? "1 row that is an exact duplicate of an earlier row"
          : `${result.totalMatched} rows that are exact duplicates of an earlier row`;
    return `${scope}:\n${renderRowTable(result.headers, result.rows, parsed)}`;
  }
  if (result.rowsMatched === 0) return "No rows match.";
  if (result.duplicateRows === 0 && result.entries.every((e) => e.duplicates === 0)) {
    return (
      `No duplicates — every row is unique and every value appears ` +
      `once in each column.`
    );
  }
  const headline =
    result.duplicateRows === 0
      ? "No exact duplicate rows."
      : result.duplicateRows === 1
        ? `1 of ${result.rowsMatched} ${plural(result.rowsMatched, "row")} is an exact duplicate of an earlier row.`
        : `${result.duplicateRows} of ${result.rowsMatched} ${plural(result.rowsMatched, "row")} are exact duplicates of an earlier row.`;
  const lines = result.entries.map((e) =>
    e.duplicates === 0
      ? `- ${e.column}: 0 duplicates`
      : `- ${e.column}: ${e.duplicates} duplicate ${plural(e.duplicates, "row")} (${valueWord(e.valuesWithDuplicates)})`,
  );
  return `${headline}\nDuplicates by column:\n${lines.join("\n")}`;
}

function composeAboveBelow(
  result: Extract<QueryResult, { kind: "aboveBelow" }>,
  parsed?: ParsedCsv,
): string {
  if (result.threshold === null) {
    return (
      `I could not compare ${result.column} to its ${result.baseline} — ` +
      `none of the ${result.rowsMatched} matching ${plural(result.rowsMatched, "row")} ` +
      `has a usable value.`
    );
  }
  if (result.totalMatched === 0) {
    return `No rows have ${result.column} ${result.direction} the ${result.baseline} of ${formatNumber(result.threshold)}.`;
  }
  const scope =
    result.limitedTo !== undefined
      ? `Showing ${result.rows.length} of ${result.totalMatched} rows with ${result.column} ${result.direction} the ${result.baseline} of ${formatNumber(result.threshold)}`
      : `${result.totalMatched} ${plural(result.totalMatched, "row")} have ${result.column} ${result.direction} the ${result.baseline} of ${formatNumber(result.threshold)}`;
  return `${scope}:\n${renderRowTable(result.headers, result.rows, parsed)}`;
}

export function composeAnswer(result: QueryResult, parsed?: ParsedCsv): string {
  switch (result.kind) {
    case "scalar":
      return composeScalar(result);
    case "rank":
      return composeRank(result);
    case "groups":
      return composeGroups(result);
    case "rows":
      return composeRows(result, parsed);
    case "aboveBelow":
      return composeAboveBelow(result, parsed);
    case "correlation":
      return composeCorrelation(result);
    case "comparison":
      return composeComparison(result);
    case "share":
      return composeShare(result);
    case "values":
      return composeValues(result);
    case "mode":
      return composeMode(result);
    case "distribution":
      return composeDistribution(result);
    case "trend":
      return composeTrend(result);
    case "missing":
      return composeMissing(result, parsed);
    case "outliers":
      return composeOutliers(result, parsed);
    case "duplicates":
      return composeDuplicates(result, parsed);
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
