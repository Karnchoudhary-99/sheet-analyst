/**
 * Query execution: run a parsed {@link Query} against a spreadsheet and
 * return a structured result the answer composer can render.
 *
 * Semantics, documented because answers must be reproducible:
 * - Filters compare numbers numerically, dates by day, and text/booleans
 *   case-insensitively. `contains` is a case-insensitive substring.
 * - Aggregates skip null (missing) values; a column with no usable
 *   values yields `value: null` and the composer says so plainly.
 * - `count` counts matching rows, including rows where the column is null.
 * - Group keys are the raw cell text, sorted by value (descending) and
 *   then by key (ascending) so ties are stable. Time-bucketed groups
 *   are the exception: their keys are period labels ("Jan 2026") and
 *   they sort chronologically, with rows whose date is blank or
 *   unparseable in a trailing "(no date)" group. Multi-column groups
 *   join their per-column values with " · " ("North · Widget A") and
 *   keep the parts in `keys` for export.
 */

import type { ParsedCsv } from "./csv.js";
import type { Filter, Query } from "./query.js";
import { inferSchema, isNullValue, type ColumnInfo } from "./schema.js";
import { outlierFence } from "./profile.js";
import { leastSquaresSlope, histogram, numericStats, ordinal, pearsonCorrelation, percentile, type HistogramBin } from "./stats.js";
import { bucketDate, parseDate, type TimeBucket } from "./time.js";

export type QueryResult =
  | {
      kind: "scalar";
      label: string;
      value: number | null;
      rowsMatched: number;
      valuesUsed: number;
    }
  | {
      kind: "rank";
      column: string;
      n: number;
      direction: "highest" | "lowest";
      /** The nth distinct value, or null when fewer than n distinct values exist. */
      value: number | null;
      /** Rows holding that value (0 when value is null). */
      rowsAtValue: number;
      /** Distinct values present in the column over the matched rows. */
      totalDistinct: number;
      rowsMatched: number;
      valuesUsed: number;
    }
  | {
      kind: "groups";
      /** The group-by columns, in the order named in the question. */
      groupBy: string[];
      column: string | null;
      op: string;
      groups: {
        /** Composite label: the per-column values joined with " · ". */
        key: string;
        /** The per-column values, in `groupBy` order. */
        keys: string[];
        value: number;
        count: number;
      }[];
      rowsMatched: number;
      limitedTo?: number;
      /** Groups before any top-N slicing, so "top 2 of 4" is honest. */
      totalGroups?: number;
      /** Set by a top-N ranking: which end of the ranking this is, so
       * the composer can say "Bottom 3 of 4" instead of "Top 3 of 4"
       * for a lowest-direction ranking. Plain group answers leave it
       * unset and are never sliced, so it is never read there. */
      direction?: "highest" | "lowest";
      /** When set, `groupBy` is a date column and `key` is a period label ("Jan 2026"). */
      bucket?: TimeBucket;
    }
  | {
      kind: "rows";
      headers: string[];
      rows: Record<string, string>[];
      totalMatched: number;
      limitedTo?: number;
      /** Set when the listing was sorted: the composer names it. */
      sortedBy?: { column: string; direction: "asc" | "desc" };
    }
  | {
      kind: "correlation";
      columnA: string;
      columnB: string;
      /** Pearson r, or null when fewer than 2 paired values or a constant column. */
      value: number | null;
      /** Rows where both columns had a usable numeric value. */
      pairs: number;
      rowsMatched: number;
    }
  | {
      kind: "comparison";
      column: string | null;
      op: string;
      dateColumn: string;
      /** Per-period aggregate: `value` is null when the period has no usable values. */
      periodA: { label: string; value: number | null; rows: number; valuesUsed: number };
      periodB: { label: string; value: number | null; rows: number; valuesUsed: number };
      /** B minus A, or null when either period has no usable value. */
      delta: number | null;
      /** Percent change vs A, or null when A is zero or either period has no usable value. */
      pctChange: number | null;
      /** Rows that fell in either period (rows outside both periods are not part of the comparison). */
      rowsMatched: number;
    }
  | {
      kind: "share";
      /** The column being shared out, or null for a row-count share. */
      column: string | null;
      /** The subset whose share this is (at least one filter). */
      filters: Filter[];
      /** OR-groups of the subset, when the question used "or". */
      orGroups?: Filter[][];
      /** The subset's total (sum of the column) or subset row count. */
      subsetValue: number;
      /** The whole sheet's total (sum of the column) or total row count. */
      totalValue: number;
      /** subsetValue / totalValue, or null when the total is zero. */
      share: number | null;
      /** Rows in the subset / rows in the whole sheet. */
      subsetRows: number;
      totalRows: number;
      /** Subset rows with a usable numeric value (row shares: the subset row count). */
      valuesUsed: number;
      /** All rows with a usable numeric value (row shares: the total row count). */
      totalValuesUsed: number;
    }
  | {
      kind: "values";
      /** The column whose distinct values are listed. */
      column: string;
      /**
       * Distinct values with row counts, most frequent first
       * (alphabetical tie-break), sliced to the query's limit.
       * Blank cells are not values and never appear here.
       */
      values: { value: string; count: number }[];
      /** Distinct values before slicing, so "showing 20 of 34" is honest. */
      totalDistinct: number;
      /** Set when the list was sliced to the limit. */
      limitedTo?: number;
      /** Rows the filters matched (the values come from these rows). */
      rowsMatched: number;
    }
  | {
      kind: "mode";
      /** The column whose most frequent value this is. */
      column: string;
      /**
       * The most frequent value, or null when no usable values.
       * Ties break alphabetically, the same rule the distinct-values
       * listing uses, so the mode is stable and reproducible.
       * Matching is case-sensitive, like the listing — "North" and
       * "north" are different spellings a user can see and fix.
       */
      value: string | null;
      /** Rows carrying the modal value (0 when there is none). */
      count: number;
      /** Distinct values seen (blank cells excluded). */
      totalDistinct: number;
      /** Rows the filters matched. */
      rowsMatched: number;
      /** Rows with a non-blank value. */
      valuesUsed: number;
    }
  | {
      kind: "distribution";
      /** The numeric column whose values are binned. */
      column: string;
      /**
       * Equal-width bins spanning [min, max]; the maximum value
       * always lands in the last bin. The bins sum to `valuesUsed`.
       */
      bins: HistogramBin[];
      /** Rows the filters matched. */
      rowsMatched: number;
      /** Rows with a usable numeric value. */
      valuesUsed: number;
      filters: Filter[];
      /** OR-groups of the filters, when the question used "or". */
      orGroups?: Filter[][];
    }
  | {
      kind: "trend";
      column: string;
      op: string;
      dateColumn: string;
      bucket: TimeBucket;
      /**
       * Per-period aggregate in chronological order. `value` is
       * null when the period has rows but none with a usable value.
       */
      periods: {
        label: string;
        value: number | null;
        rows: number;
        valuesUsed: number;
      }[];
      /**
       * Least-squares slope per period, or null with fewer than two
       * periods carrying a usable value.
       */
      slope: number | null;
      /**
       * "flat" when |slope| is under 1% of the typical period value
       * (noise, not a trend); null when the slope is.
       */
      direction: "up" | "down" | "flat" | null;
      /** Rows the filters matched, including rows with no usable date. */
      rowsMatched: number;
    }
  | {
      kind: "aboveBelow";
      column: string;
      direction: "above" | "below";
      baseline: "average" | "median";
      /**
       * Mean or median of the column over the matched rows, or null
       * when none of them has a usable value — then there is no
       * baseline to compare against and `rows` is empty.
       */
      threshold: number | null;
      headers: string[];
      /** Matching rows, in sheet order, sliced to the query's limit. */
      rows: Record<string, string>[];
      /** Rows on the asked side of the baseline. */
      totalMatched: number;
      limitedTo?: number;
      /** Rows the filters matched (the baseline is computed over these). */
      rowsMatched: number;
    }
  | {
      kind: "missing";
      /** The column checked, or null for a whole-sheet report. */
      column: string | null;
      /**
       * Missing counts per column, most missing first (alphabetical
       * tie-break). A single-column question lists just that column;
       * a whole-sheet report lists every column, including the
       * complete ones, so "no missing values" is visible, not
       * implied by absence.
       */
      entries: { column: string; missing: number; total: number }[];
      headers: string[];
      /**
       * Rows missing the column, in sheet order, sliced to 10 —
       * only when the question asked to list them; empty otherwise.
       */
      rows: Record<string, string>[];
      /** Rows missing the column (0 unless the question listed them). */
      totalMatched: number;
      limitedTo?: number;
      /** True when the question asked to list the rows. */
      listRows: boolean;
      /** Rows the filters matched (the counts are over these). */
      rowsMatched: number;
    }
  | {
      kind: "outliers";
      /** The column checked, or null for a whole-sheet report. */
      column: string | null;
      /**
       * Outlier counts per column, most outliers first (alphabetical
       * tie-break). A single-column question lists just that column;
       * a whole-sheet report lists every numeric column, including
       * the clean ones, so "no outliers" is visible, not implied by
       * absence. Text/date/boolean columns never appear: an outlier
       * needs numbers.
       */
      entries: {
        column: string;
        /** Rows with a usable value in this column. */
        total: number;
        /** Rows whose value falls outside the fence. */
        outliers: number;
        /** The fence bounds; null when fewer than 4 usable values. */
        lowBound: number | null;
        highBound: number | null;
        /** Smallest / largest outlier seen; null when there are none. */
        low: number | null;
        high: number | null;
      }[];
      headers: string[];
      /**
       * Rows that are outliers in the column, in sheet order, sliced
       * to 10 — only when the question asked to list them; empty
       * otherwise.
       */
      rows: Record<string, string>[];
      /** Outlier rows (0 unless the question listed them). */
      totalMatched: number;
      limitedTo?: number;
      /** True when the question asked to list the rows. */
      listRows: boolean;
      /** Rows the filters matched (the counts are over these). */
      rowsMatched: number;
    }
  | {
      kind: "duplicates";
      /** The column checked, or null for a whole-sheet report. */
      column: string | null;
      /**
       * Full rows beyond the first occurrence of an identical row
       * (raw cell text, blanks included — the same definition the
       * data-quality profile uses). A single-column question still
       * reports it, so the whole-sheet picture is never hidden.
       */
      duplicateRows: number;
      /**
       * Duplicate counts per column, most duplicates first
       * (alphabetical tie-break). A single-column question lists
       * just that column; a whole-sheet report lists every column,
       * including the clean ones, so "no duplicates" is visible,
       * not implied by absence.
       */
      entries: {
        column: string;
        /** Rows beyond the first occurrence of a repeated value. */
        duplicates: number;
        /** Rows with a non-blank value (blanks are not values). */
        total: number;
        /** Distinct values that appear more than once. */
        valuesWithDuplicates: number;
      }[];
      headers: string[];
      /**
       * Duplicate rows, in sheet order, sliced to 10 — only when
       * the question asked to list them; empty otherwise. With a
       * column named, the rows whose value already appeared
       * earlier; without one, the exact duplicate rows.
       */
      rows: Record<string, string>[];
      /** Duplicate rows (0 unless the question listed them). */
      totalMatched: number;
      limitedTo?: number;
      /** True when the question asked to list the rows. */
      listRows: boolean;
      /** Rows the filters matched (the counts are over these). */
      rowsMatched: number;
    };

function toNumber(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toEpoch(value: string): number | null {
  // Dates compare by day (see the module doc): a datetime cell
  // counts as its calendar day, so "after 2026-03-01" matches the
  // whole of 2026-03-02 and nothing on 2026-03-01 itself.
  const d = parseDate(value);
  return d ? Date.UTC(d.year, d.month - 1, d.day) : null;
}

/**
 * The key a row's group-by cell maps to. Without a bucket it is the
 * raw cell text ("(blank)" when empty). With a bucket the cell must
 * be a date: it maps to the period's label ("Jan 2026"), sorted by
 * its chronological key; a blank or unparseable date maps to
 * "(no date)", which always sorts last so it never looks like a
 * period.
 */
function groupKey(
  raw: string,
  bucket: TimeBucket | undefined,
): { mapKey: string; label: string; sortKey: string } {
  const cell = raw.trim();
  if (!bucket) {
    const label = cell === "" ? "(blank)" : cell;
    return { mapKey: label, label, sortKey: label };
  }
  const b = cell === "" ? null : bucketDate(cell, bucket);
  if (b) return { mapKey: b.key, label: b.label, sortKey: b.key };
  // "\uFFFF" sorts after any ISO period key ("2026-01", "2026-Q1").
  return { mapKey: "(no date)", label: "(no date)", sortKey: "\uFFFF" };
}

/**
 * Compare two cells from the same row — the engine side of a
 * cross-column filter ("revenue > units"). Both cells must hold a
 * usable value: a blank or unparseable cell never matches, so a row
 * with no units is not "revenue greater than units", it is no
 * answer for that row. Numbers compare numerically, dates by day,
 * text by case-insensitive equality (ordered text comparisons are
 * refused by the parser, so they return false here too).
 */
function compareCells(
  a: string,
  infoA: ColumnInfo,
  op: Filter["op"],
  b: string,
  infoB: ColumnInfo,
): boolean {
  if (isNullValue(a) || isNullValue(b)) return false;
  const aNum = infoA.type === "integer" || infoA.type === "number";
  const bNum = infoB.type === "integer" || infoB.type === "number";
  if (aNum && bNum) {
    const x = toNumber(a);
    const y = toNumber(b);
    if (x === null || y === null) return false;
    if (op === "=") return x === y;
    if (op === "!=") return x !== y;
    if (op === ">") return x > y;
    if (op === ">=") return x >= y;
    if (op === "<") return x < y;
    if (op === "<=") return x <= y;
    return false;
  }
  if (infoA.type === "date" && infoB.type === "date") {
    const x = toEpoch(a);
    const y = toEpoch(b);
    if (x === null || y === null) return false;
    if (op === "=") return x === y;
    if (op === "!=") return x !== y;
    if (op === ">") return x > y;
    if (op === ">=") return x >= y;
    if (op === "<") return x < y;
    if (op === "<=") return x <= y;
    return false;
  }
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (op === "=") return x === y;
  if (op === "!=") return x !== y;
  if (op === "contains") return x.includes(y);
  return false;
}

function compareValues(cell: string, info: ColumnInfo, op: Filter["op"], raw: string): boolean {
  if (isNullValue(cell)) return false;
  if (info.type === "integer" || info.type === "number") {
    const a = toNumber(cell);
    const b = toNumber(raw);
    if (a === null || b === null) return false;
    if (op === "=") return a === b;
    if (op === "!=") return a !== b;
    if (op === ">") return a > b;
    if (op === ">=") return a >= b;
    if (op === "<") return a < b;
    if (op === "<=") return a <= b;
    return false;
  }
  if (info.type === "date") {
    const a = toEpoch(cell);
    const b = toEpoch(raw);
    if (a === null || b === null) return false;
    if (op === "=") return a === b;
    if (op === "!=") return a !== b;
    if (op === ">") return a > b;
    if (op === ">=") return a >= b;
    if (op === "<") return a < b;
    if (op === "<=") return a <= b;
    return false;
  }
  const a = cell.trim().toLowerCase();
  const b = raw.trim().toLowerCase();
  if (op === "=") return a === b;
  if (op === "!=") return a !== b;
  if (op === "contains") return a.includes(b);
  return false;
}

/**
 * Rows matching a query's filters: every `filters` entry must hold
 * (AND), and when `orGroups` is non-empty at least one group must
 * hold fully (each group is itself an AND). A row passes only when
 * both sides pass — "where revenue > 100 and region is North or
 * South" is revenue > 100 AND (North OR South), never just the OR.
 */
export function applyFilters(
  parsed: ParsedCsv,
  schema: ColumnInfo[],
  filters: Filter[],
  orGroups: Filter[][] = [],
): string[][] {
  if (filters.length === 0 && orGroups.length === 0) return parsed.rows;
  const colIndex = new Map(schema.map((c, i) => [c.name, i]));
  const matches = (row: string[], fs: Filter[]): boolean =>
    fs.every((f) => {
      const idx = colIndex.get(f.column);
      if (idx === undefined) return false;
      if (f.compareColumn !== undefined) {
        const other = colIndex.get(f.compareColumn);
        if (other === undefined) return false;
        return compareCells(
          row[idx] ?? "",
          schema[idx],
          f.op,
          row[other] ?? "",
          schema[other],
        );
      }
      return compareValues(row[idx] ?? "", schema[idx], f.op, f.value);
    });
  return parsed.rows.filter(
    (row) =>
      matches(row, filters) &&
      (orGroups.length === 0 || orGroups.some((g) => matches(row, g))),
  );
}

/**
 * Order rows by one column's values: numbers numerically, dates by
 * day, everything else case-insensitively alphabetical. Blank cells
 * always sort last in both directions — a missing value is not the
 * smallest or the largest value, it is no value at all, and putting
 * it first in a descending sort would present it as the top row.
 * The sort is stable (Array.prototype.sort is stable in Node), so
 * rows that tie keep their sheet order.
 */
function sortRows(
  rows: string[][],
  schema: ColumnInfo[],
  sort: { column: string; direction: "asc" | "desc" },
): string[][] {
  const idx = schema.findIndex((c) => c.name === sort.column);
  if (idx === -1) return rows;
  const info = schema[idx]!;
  const sign = sort.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[idx] ?? "";
    const bv = b[idx] ?? "";
    const aNull = isNullValue(av);
    const bNull = isNullValue(bv);
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (info.type === "integer" || info.type === "number") {
      const an = toNumber(av);
      const bn = toNumber(bv);
      if (an === null && bn === null) return 0;
      if (an === null) return 1;
      if (bn === null) return -1;
      return sign * (an - bn);
    }
    if (info.type === "date") {
      const ae = toEpoch(av);
      const be = toEpoch(bv);
      if (ae === null && be === null) return 0;
      if (ae === null) return 1;
      if (be === null) return -1;
      return sign * (ae - be);
    }
    return sign * av.trim().toLowerCase().localeCompare(bv.trim().toLowerCase());
  });
}

function aggregateValues(op: string, values: number[]): number | null {
  if (values.length === 0) return null;
  const s = numericStats(values);
  switch (op) {
    case "sum":
      return s.sum;
    case "mean":
      return s.mean;
    case "median":
      return s.median;
    case "min":
      return s.min;
    case "max":
      return s.max;
    case "count":
      return values.length;
    default:
      return null;
  }
}

const OP_LABEL: Record<string, string> = {
  sum: "total",
  mean: "average",
  median: "median",
  min: "minimum",
  max: "maximum",
  count: "count",
};

/**
 * Count raw cell text per value over the given rows. Blank cells are
 * not values and never appear. Matching is case-sensitive because
 * the values are displayed, not compared — "North" and "north" are
 * different spellings a user can see and fix. Sorted most frequent
 * first, alphabetical tie-break, so the mode and the distinct-values
 * listing agree with each other.
 */
function countRawValues(
  rows: string[][],
  cIdx: number,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const cell = (row[cIdx] ?? "").trim();
    if (cell === "") continue;
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function executeQuery(query: Query, parsed: ParsedCsv): QueryResult {
  const schema = inferSchema(parsed);
  const colIndex = new Map(schema.map((c, i) => [c.name, i]));
  const colInfo = (name: string): ColumnInfo | undefined =>
    schema[colIndex.get(name) ?? -1];

  switch (query.kind) {
    case "count": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      return {
        kind: "scalar",
        label: "count",
        value: rows.length,
        rowsMatched: rows.length,
        valuesUsed: rows.length,
      };
    }

    case "aggregate": {
      const info = colInfo(query.column);
      if (!info) throw new Error(`unknown column: ${query.column}`);
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const values = rows
        .map((r) => r[colIndex.get(query.column)!] ?? "")
        .filter((v) => !isNullValue(v))
        .map(toNumber)
        .filter((n): n is number => n !== null);
      return {
        kind: "scalar",
        label: `${OP_LABEL[query.op] ?? query.op} ${query.column}`,
        value: aggregateValues(query.op, values),
        rowsMatched: rows.length,
        valuesUsed: values.length,
      };
    }

    case "group": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const gIdxs = query.groupBy.map((name) => colIndex.get(name)!);
      const cIdx = query.column ? colIndex.get(query.column)! : -1;
      // A time bucket only ever groups one column (the parser
      // refuses a bucket plus a second group column), so at most one
      // part of a composite key is a period label.
      const buckets = new Map<
        string,
        { labels: string[]; sortKeys: string[]; values: number[]; count: number }
      >();
      for (const row of rows) {
        const parts = gIdxs.map((gi) => groupKey(row[gi] ?? "", query.bucket));
        const mapKey = parts.map((p) => p.mapKey).join("\u0000");
        const bucket = buckets.get(mapKey) ?? {
          labels: parts.map((p) => p.label),
          sortKeys: parts.map((p) => p.sortKey),
          values: [],
          count: 0,
        };
        bucket.count += 1;
        if (cIdx >= 0) {
          const raw = row[cIdx] ?? "";
          if (!isNullValue(raw)) {
            const n = toNumber(raw);
            if (n !== null) bucket.values.push(n);
          }
        }
        buckets.set(mapKey, bucket);
      }
      const groups = [...buckets.values()]
        .map((b) => ({
          key: b.labels.join(" · "),
          keys: b.labels,
          value: query.column ? (aggregateValues(query.op, b.values) ?? 0) : b.count,
          count: b.count,
          sortKey: b.sortKeys.join("\u0000"),
        }))
        // Time buckets read chronologically; plain groups read
        // largest first with alphabetical tie-breaks.
        .sort((a, b) =>
          query.bucket
            ? a.sortKey.localeCompare(b.sortKey)
            : b.value - a.value || a.key.localeCompare(b.key),
        )
        .map(({ key, keys, value, count }) => ({ key, keys, value, count }));
      return {
        kind: "groups",
        groupBy: query.groupBy,
        column: query.column,
        op: query.op,
        groups,
        rowsMatched: rows.length,
        totalGroups: groups.length,
        bucket: query.bucket,
      };
    }

    case "top": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      if (query.groupBy) {
        // Rank groups by the summed column (the "by revenue" in
        // "top 3 products by revenue"). With a time bucket the
        // groups are periods ("top 3 months by revenue"). Several
        // group columns rank their combinations ("top 3 region and
        // product by revenue").
        const gIdxs = query.groupBy.map((name) => colIndex.get(name)!);
        const cIdx = colIndex.get(query.column)!;
        const buckets = new Map<
          string,
          { labels: string[]; sum: number; count: number }
        >();
        for (const row of rows) {
          const parts = gIdxs.map((gi) => groupKey(row[gi] ?? "", query.bucket));
          const mapKey = parts.map((p) => p.mapKey).join("\u0000");
          const bucket = buckets.get(mapKey) ?? {
            labels: parts.map((p) => p.label),
            sum: 0,
            count: 0,
          };
          bucket.count += 1;
          const raw = row[cIdx] ?? "";
          if (!isNullValue(raw)) {
            const n = toNumber(raw);
            if (n !== null) bucket.sum += n;
          }
          buckets.set(mapKey, bucket);
        }
        const groups = [...buckets.values()]
          .map((b) => ({
            key: b.labels.join(" · "),
            keys: b.labels,
            value: b.sum,
            count: b.count,
          }))
          .sort((a, b) =>
            query.direction === "highest"
              ? b.value - a.value || a.key.localeCompare(b.key)
              : a.value - b.value || a.key.localeCompare(b.key),
          );
        const limited = groups.length > query.limit;
        return {
          kind: "groups",
          groupBy: query.groupBy,
          column: query.column,
          op: "sum",
          groups: limited ? groups.slice(0, query.limit) : groups,
          rowsMatched: rows.length,
          limitedTo: limited ? query.limit : undefined,
          totalGroups: groups.length,
          direction: query.direction,
          bucket: query.bucket,
        };
      }

      // Rank rows by the column.
      const cIdx = colIndex.get(query.column)!;
      const ranked = rows
        .map((row) => ({ row, n: toNumber(row[cIdx] ?? "") }))
        .filter((x): x is { row: string[]; n: number } => x.n !== null)
        .sort((a, b) => (query.direction === "highest" ? b.n - a.n : a.n - b.n))
        .slice(0, query.limit);
      const records = ranked.map(({ row }) => {
        const rec: Record<string, string> = {};
        parsed.headers.forEach((h, i) => {
          rec[h] = row[i] ?? "";
        });
        return rec;
      });
      return {
        kind: "rows",
        headers: parsed.headers,
        rows: records,
        totalMatched: rows.length,
        limitedTo: query.limit,
      };
    }

    case "correlation": {
      const aIdx = colIndex.get(query.columnA)!;
      const bIdx = colIndex.get(query.columnB)!;
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      // Only rows where BOTH columns have a usable numeric value
      // pair up; a blank in either column drops the row from the
      // pairing, never from the row count.
      const xs: number[] = [];
      const ys: number[] = [];
      for (const row of rows) {
        const aRaw = row[aIdx] ?? "";
        const bRaw = row[bIdx] ?? "";
        if (isNullValue(aRaw) || isNullValue(bRaw)) continue;
        const a = toNumber(aRaw);
        const b = toNumber(bRaw);
        if (a === null || b === null) continue;
        xs.push(a);
        ys.push(b);
      }
      return {
        kind: "correlation",
        columnA: query.columnA,
        columnB: query.columnB,
        value: pearsonCorrelation(xs, ys),
        pairs: xs.length,
        rowsMatched: rows.length,
      };
    }

    case "rows": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      // Sort before slicing: the limit keeps the first N of the
      // sorted order, not the first N of the sheet.
      const ordered = query.sort ? sortRows(rows, schema, query.sort) : rows;
      const shown = ordered.slice(0, query.limit);
      const records = shown.map((row) => {
        const rec: Record<string, string> = {};
        parsed.headers.forEach((h, i) => {
          rec[h] = row[i] ?? "";
        });
        return rec;
      });
      return {
        kind: "rows",
        headers: parsed.headers,
        rows: records,
        totalMatched: rows.length,
        limitedTo: rows.length > query.limit ? query.limit : undefined,
        sortedBy: query.sort,
      };
    }

    case "share": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const totalRows = parsed.rows.length;
      if (query.column === null) {
        // Row-count share: the filtered rows as a fraction of all rows.
        return {
          kind: "share",
          column: null,
          filters: query.filters,
          orGroups: query.orGroups,
          subsetValue: rows.length,
          totalValue: totalRows,
          share: totalRows === 0 ? null : rows.length / totalRows,
          subsetRows: rows.length,
          totalRows,
          valuesUsed: rows.length,
          totalValuesUsed: totalRows,
        };
      }
      // Value share: the subset's total of the column as a fraction
      // of the whole sheet's total. Nulls are skipped on both sides,
      // so a blank cell never counts as a zero in either total.
      const cIdx = colIndex.get(query.column)!;
      const sumOf = (rs: string[][]): { sum: number; used: number } => {
        let sum = 0;
        let used = 0;
        for (const r of rs) {
          const raw = r[cIdx] ?? "";
          if (isNullValue(raw)) continue;
          const n = toNumber(raw);
          if (n === null) continue;
          sum += n;
          used += 1;
        }
        return { sum, used };
      };
      const subset = sumOf(rows);
      const total = sumOf(parsed.rows);
      return {
        kind: "share",
        column: query.column,
        filters: query.filters,
        orGroups: query.orGroups,
        subsetValue: subset.sum,
        totalValue: total.sum,
        share: total.sum === 0 ? null : subset.sum / total.sum,
        subsetRows: rows.length,
        totalRows,
        valuesUsed: subset.used,
        totalValuesUsed: total.used,
      };
    }

    case "distinct": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const cIdx = colIndex.get(query.column)!;
      const values = countRawValues(rows, cIdx);
      const limited = values.length > query.limit;
      return {
        kind: "values",
        column: query.column,
        values: limited ? values.slice(0, query.limit) : values,
        totalDistinct: values.length,
        limitedTo: limited ? query.limit : undefined,
        rowsMatched: rows.length,
      };
    }

    case "mode": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const cIdx = colIndex.get(query.column)!;
      const values = countRawValues(rows, cIdx);
      const top = values[0];
      return {
        kind: "mode",
        column: query.column,
        value: top?.value ?? null,
        count: top?.count ?? 0,
        totalDistinct: values.length,
        rowsMatched: rows.length,
        valuesUsed: values.reduce((n, v) => n + v.count, 0),
      };
    }

    case "distribution": {
      const info = colInfo(query.column);
      if (!info) throw new Error(`unknown column: ${query.column}`);
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const values = rows
        .map((r) => r[colIndex.get(query.column)!] ?? "")
        .filter((v) => !isNullValue(v))
        .map(toNumber)
        .filter((n): n is number => n !== null);
      // Never more bins than distinct values: a histogram with
      // more bins than values is mostly empty bars. Ten is the cap.
      const bins = histogram(
        values,
        Math.max(1, Math.min(10, new Set(values).size)),
      );
      return {
        kind: "distribution",
        column: query.column,
        bins,
        rowsMatched: rows.length,
        valuesUsed: values.length,
        filters: query.filters,
        orGroups: query.orGroups,
      };
    }

    case "percentile": {
      const info = colInfo(query.column);
      if (!info) throw new Error(`unknown column: ${query.column}`);
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const values = rows
        .map((r) => r[colIndex.get(query.column)!] ?? "")
        .filter((v) => !isNullValue(v))
        .map(toNumber)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      return {
        kind: "scalar",
        label: `${ordinal(query.p)} percentile of ${query.column}`,
        value: values.length === 0 ? null : percentile(values, query.p / 100),
        rowsMatched: rows.length,
        valuesUsed: values.length,
      };
    }

    case "rank": {
      const info = colInfo(query.column);
      if (!info) throw new Error(`unknown column: ${query.column}`);
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const values = rows
        .map((r) => r[colIndex.get(query.column)!] ?? "")
        .filter((v) => !isNullValue(v))
        .map(toNumber)
        .filter((n): n is number => n !== null);
      // Rank counts distinct values, not rows: with values
      // 98,000 / 95,000 / 95,000 / 91,000 the 2nd highest is
      // 95,000, held by 2 rows. Counting rows would make a tie
      // depend on sort order, so the same question could answer
      // differently run to run.
      const distinct = [...new Set(values)].sort((a, b) =>
        query.direction === "highest" ? b - a : a - b,
      );
      const value = query.n <= distinct.length ? distinct[query.n - 1]! : null;
      return {
        kind: "rank",
        column: query.column,
        n: query.n,
        direction: query.direction,
        value,
        rowsAtValue: value === null ? 0 : values.filter((v) => v === value).length,
        totalDistinct: distinct.length,
        rowsMatched: rows.length,
        valuesUsed: values.length,
      };
    }

    case "distinctCount": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const cIdx = colIndex.get(query.column)!;
      const values = countRawValues(rows, cIdx);
      return {
        kind: "scalar",
        label: `distinct ${query.column} values`,
        value: values.length,
        rowsMatched: rows.length,
        valuesUsed: values.reduce((n, v) => n + v.count, 0),
      };
    }

    case "comparison": {
      const dIdx = colIndex.get(query.dateColumn)!;
      const cIdx = query.column ? colIndex.get(query.column)! : -1;
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const inPeriod = (row: string[], bucket: TimeBucket, key: string): boolean => {
        const b = bucketDate(row[dIdx] ?? "", bucket);
        return b !== null && b.key === key;
      };
      const period = (spec: { bucket: TimeBucket; key: string; label: string }) => {
        const periodRows = rows.filter((r) => inPeriod(r, spec.bucket, spec.key));
        if (cIdx < 0) {
          return { label: spec.label, value: periodRows.length, rows: periodRows.length, valuesUsed: periodRows.length };
        }
        const values = periodRows
          .map((r) => r[cIdx] ?? "")
          .filter((v) => !isNullValue(v))
          .map(toNumber)
          .filter((n): n is number => n !== null);
        return {
          label: spec.label,
          value: aggregateValues(query.op, values),
          rows: periodRows.length,
          valuesUsed: values.length,
        };
      };
      const a = period(query.periodA);
      const b = period(query.periodB);
      const delta = a.value === null || b.value === null ? null : b.value - a.value;
      const pctChange =
        delta === null || a.value === null || a.value === 0
          ? null
          : (delta / a.value) * 100;
      return {
        kind: "comparison",
        column: query.column,
        op: query.op,
        dateColumn: query.dateColumn,
        periodA: a,
        periodB: b,
        delta,
        pctChange,
        rowsMatched: a.rows + b.rows,
      };
    }

    case "trend": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const dIdx = colIndex.get(query.dateColumn)!;
      const cIdx = colIndex.get(query.column)!;
      // Bucket the filtered rows by period. Rows with no usable date
      // are not on the timeline, so they take no part in the fit —
      // they still count in rowsMatched.
      const buckets = new Map<
        string,
        { label: string; values: number[]; count: number }
      >();
      for (const row of rows) {
        const b = bucketDate(row[dIdx] ?? "", query.bucket);
        if (!b) continue;
        const bucket = buckets.get(b.key) ?? { label: b.label, values: [], count: 0 };
        bucket.count += 1;
        const raw = row[cIdx] ?? "";
        if (!isNullValue(raw)) {
          const n = toNumber(raw);
          if (n !== null) bucket.values.push(n);
        }
        buckets.set(b.key, bucket);
      }
      const periods = [...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, b]) => ({
          label: b.label,
          value: aggregateValues(query.op, b.values),
          rows: b.count,
          valuesUsed: b.values.length,
        }));
      // The fit uses only periods with a usable value, at their
      // position in the full period list, so a gap period keeps the
      // slope honest instead of compressing the timeline.
      const fitted = periods
        .map((p, i) => ({ x: i, value: p.value }))
        .filter((p): p is { x: number; value: number } => p.value !== null);
      const slope =
        fitted.length >= 2
          ? leastSquaresSlope(
              fitted.map((p) => p.x),
              fitted.map((p) => p.value),
            )
          : null;
      let direction: "up" | "down" | "flat" | null = null;
      if (slope !== null) {
        // "Flat" is relative: a slope under 1% of the typical period
        // value is noise, not a trend.
        const meanAbs =
          fitted.reduce((acc, p) => acc + Math.abs(p.value), 0) / fitted.length;
        direction =
          Math.abs(slope) <= 0.01 * meanAbs ? "flat" : slope > 0 ? "up" : "down";
      }
      return {
        kind: "trend",
        column: query.column,
        op: query.op,
        dateColumn: query.dateColumn,
        bucket: query.bucket,
        periods,
        slope,
        direction,
        rowsMatched: rows.length,
      };
    }

    case "missing": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      // A "missing value" is what the schema calls null: empty, or
      // a marker like NA or N/A — never a zero, which is a value.
      const countMissing = (cIdx: number): number => {
        let n = 0;
        for (const row of rows) {
          if (isNullValue(row[cIdx] ?? "")) n += 1;
        }
        return n;
      };
      const names =
        query.column !== null ? [query.column] : schema.map((c) => c.name);
      const entries = names
        .map((name) => ({
          column: name,
          missing: countMissing(colIndex.get(name)!),
          total: rows.length,
        }))
        // Most missing first, so the problem columns lead the report;
        // alphabetical tie-break keeps the order stable.
        .sort((a, b) => b.missing - a.missing || a.column.localeCompare(b.column));
      let records: Record<string, string>[] = [];
      let totalMatched = 0;
      let limitedTo: number | undefined;
      if (query.listRows && query.column !== null) {
        const cIdx = colIndex.get(query.column)!;
        const matching = rows.filter((row) => isNullValue(row[cIdx] ?? ""));
        totalMatched = matching.length;
        const shown = matching.slice(0, 10);
        records = shown.map((row) => {
          const rec: Record<string, string> = {};
          parsed.headers.forEach((h, i) => {
            rec[h] = row[i] ?? "";
          });
          return rec;
        });
        limitedTo = matching.length > 10 ? 10 : undefined;
      }
      return {
        kind: "missing",
        column: query.column,
        entries,
        headers: parsed.headers,
        rows: records,
        totalMatched,
        limitedTo,
        listRows: query.listRows,
        rowsMatched: rows.length,
      };
    }

    case "outliers": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      // One entry per numeric column: the Tukey fence over the
      // matched rows' usable values, and how many of them fall
      // outside it. A blank is not an outlier — it is no value —
      // and a zero is a value, never an outlier by itself.
      const buildEntry = (name: string) => {
        const cIdx = colIndex.get(name)!;
        const values: number[] = [];
        for (const row of rows) {
          const raw = row[cIdx] ?? "";
          if (isNullValue(raw)) continue;
          const n = toNumber(raw);
          if (n !== null) values.push(n);
        }
        const fence = outlierFence(values);
        const outside =
          fence === null
            ? []
            : values.filter((v) => v < fence.lowBound || v > fence.highBound);
        return {
          column: name,
          total: values.length,
          outliers: outside.length,
          lowBound: fence?.lowBound ?? null,
          highBound: fence?.highBound ?? null,
          low: outside.length === 0 ? null : Math.min(...outside),
          high: outside.length === 0 ? null : Math.max(...outside),
        };
      };
      const names =
        query.column !== null
          ? [query.column]
          : schema
              .filter((c) => c.type === "integer" || c.type === "number")
              .map((c) => c.name);
      const entries = names
        .map(buildEntry)
        // Most outliers first, so the problem columns lead the report;
        // alphabetical tie-break keeps the order stable.
        .sort((a, b) => b.outliers - a.outliers || a.column.localeCompare(b.column));
      let records: Record<string, string>[] = [];
      let totalMatched = 0;
      let limitedTo: number | undefined;
      if (query.listRows && query.column !== null) {
        const entry = entries[0]!;
        if (entry.lowBound !== null && entry.highBound !== null) {
          const cIdx = colIndex.get(query.column)!;
          const matching = rows.filter((row) => {
            const n = toNumber(row[cIdx] ?? "");
            return (
              n !== null && (n < entry.lowBound! || n > entry.highBound!)
            );
          });
          totalMatched = matching.length;
          const shown = matching.slice(0, 10);
          records = shown.map((row) => {
            const rec: Record<string, string> = {};
            parsed.headers.forEach((h, i) => {
              rec[h] = row[i] ?? "";
            });
            return rec;
          });
          limitedTo = matching.length > 10 ? 10 : undefined;
        }
      }
      return {
        kind: "outliers",
        column: query.column,
        entries,
        headers: parsed.headers,
        rows: records,
        totalMatched,
        limitedTo,
        listRows: query.listRows,
        rowsMatched: rows.length,
      };
    }

    case "duplicates": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      // Exact duplicate rows: rows beyond the first occurrence of
      // an identical row — raw cell text, blanks included, the same
      // definition the data-quality profile uses. Their positions
      // are kept so a listing can show them in sheet order.
      const seenRows = new Set<string>();
      let duplicateRows = 0;
      const fullRowDupes: string[][] = [];
      for (const row of rows) {
        const key = row.map((cell) => cell ?? "").join("\u0000");
        if (seenRows.has(key)) {
          duplicateRows += 1;
          fullRowDupes.push(row);
        } else {
          seenRows.add(key);
        }
      }
      // Per-column duplicates: rows beyond the first occurrence of
      // a repeated value. Blank cells are not values — two blanks
      // are two missing values, never a duplicate — so the counts
      // come from countRawValues, which skips blanks.
      const buildEntry = (name: string) => {
        const cIdx = colIndex.get(name)!;
        const counts = countRawValues(rows, cIdx);
        return {
          column: name,
          duplicates: counts.reduce(
            (n, v) => n + (v.count > 1 ? v.count - 1 : 0),
            0,
          ),
          total: counts.reduce((n, v) => n + v.count, 0),
          valuesWithDuplicates: counts.filter((v) => v.count > 1).length,
        };
      };
      const names =
        query.column !== null ? [query.column] : schema.map((c) => c.name);
      const entries = names
        .map(buildEntry)
        // Most duplicates first, so the problem columns lead the
        // report; alphabetical tie-break keeps the order stable.
        .sort((a, b) => b.duplicates - a.duplicates || a.column.localeCompare(b.column));
      let records: Record<string, string>[] = [];
      let totalMatched = 0;
      let limitedTo: number | undefined;
      if (query.listRows) {
        let matching: string[][];
        if (query.column !== null) {
          // Rows whose value already appeared earlier in the
          // column, in sheet order — blanks never qualify.
          const cIdx = colIndex.get(query.column)!;
          const seen = new Set<string>();
          matching = rows.filter((row) => {
            const cell = (row[cIdx] ?? "").trim();
            if (cell === "") return false;
            if (seen.has(cell)) return true;
            seen.add(cell);
            return false;
          });
        } else {
          matching = fullRowDupes;
        }
        totalMatched = matching.length;
        const shown = matching.slice(0, 10);
        records = shown.map((row) => {
          const rec: Record<string, string> = {};
          parsed.headers.forEach((h, i) => {
            rec[h] = row[i] ?? "";
          });
          return rec;
        });
        limitedTo = matching.length > 10 ? 10 : undefined;
      }
      return {
        kind: "duplicates",
        column: query.column,
        duplicateRows,
        entries,
        headers: parsed.headers,
        rows: records,
        totalMatched,
        limitedTo,
        listRows: query.listRows,
        rowsMatched: rows.length,
      };
    }

    case "aboveBelow": {
      const rows = applyFilters(parsed, schema, query.filters, query.orGroups);
      const cIdx = colIndex.get(query.column)!;
      // The baseline is computed over the matched rows only, skipping
      // rows with no usable value — a blank is not a zero.
      const values: number[] = [];
      for (const row of rows) {
        const raw = row[cIdx] ?? "";
        if (isNullValue(raw)) continue;
        const n = toNumber(raw);
        if (n !== null) values.push(n);
      }
      const stats = values.length > 0 ? numericStats(values) : null;
      const threshold =
        stats === null ? null : query.baseline === "median" ? stats.median : stats.mean;
      // Strictly on one side: a row equal to the baseline is neither
      // above nor below it.
      const matching =
        threshold === null
          ? []
          : rows.filter((row) => {
              const n = toNumber(row[cIdx] ?? "");
              return (
                n !== null &&
                (query.direction === "above" ? n > threshold : n < threshold)
              );
            });
      const shown = matching.slice(0, 10);
      const records = shown.map((row) => {
        const rec: Record<string, string> = {};
        parsed.headers.forEach((h, i) => {
          rec[h] = row[i] ?? "";
        });
        return rec;
      });
      return {
        kind: "aboveBelow",
        column: query.column,
        direction: query.direction,
        baseline: query.baseline,
        threshold,
        headers: parsed.headers,
        rows: records,
        totalMatched: matching.length,
        limitedTo: matching.length > 10 ? 10 : undefined,
        rowsMatched: rows.length,
      };
    }
  }
}
