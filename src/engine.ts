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
 *   unparseable in a trailing "(no date)" group.
 */

import type { ParsedCsv } from "./csv.js";
import type { Filter, Query } from "./query.js";
import { inferSchema, isNullValue, type ColumnInfo } from "./schema.js";
import { numericStats, pearsonCorrelation } from "./stats.js";
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
      kind: "groups";
      groupBy: string;
      column: string | null;
      op: string;
      groups: { key: string; value: number; count: number }[];
      rowsMatched: number;
      limitedTo?: number;
      /** Groups before any top-N slicing, so "top 2 of 4" is honest. */
      totalGroups?: number;
      /** When set, `groupBy` is a date column and `key` is a period label ("Jan 2026"). */
      bucket?: TimeBucket;
    }
  | {
      kind: "rows";
      headers: string[];
      rows: Record<string, string>[];
      totalMatched: number;
      limitedTo?: number;
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

export function applyFilters(
  parsed: ParsedCsv,
  schema: ColumnInfo[],
  filters: Filter[],
): string[][] {
  if (filters.length === 0) return parsed.rows;
  const colIndex = new Map(schema.map((c, i) => [c.name, i]));
  return parsed.rows.filter((row) =>
    filters.every((f) => {
      const idx = colIndex.get(f.column);
      if (idx === undefined) return false;
      return compareValues(row[idx] ?? "", schema[idx], f.op, f.value);
    }),
  );
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

export function executeQuery(query: Query, parsed: ParsedCsv): QueryResult {
  const schema = inferSchema(parsed);
  const colIndex = new Map(schema.map((c, i) => [c.name, i]));
  const colInfo = (name: string): ColumnInfo | undefined =>
    schema[colIndex.get(name) ?? -1];

  switch (query.kind) {
    case "count": {
      const rows = applyFilters(parsed, schema, query.filters);
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
      const rows = applyFilters(parsed, schema, query.filters);
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
      const rows = applyFilters(parsed, schema, query.filters);
      const gIdx = colIndex.get(query.groupBy)!;
      const cIdx = query.column ? colIndex.get(query.column)! : -1;
      const buckets = new Map<
        string,
        { label: string; sortKey: string; values: number[]; count: number }
      >();
      for (const row of rows) {
        const k = groupKey(row[gIdx] ?? "", query.bucket);
        const bucket = buckets.get(k.mapKey) ?? {
          label: k.label,
          sortKey: k.sortKey,
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
        buckets.set(k.mapKey, bucket);
      }
      const groups = [...buckets.values()]
        .map((b) => ({
          key: b.label,
          value: query.column ? (aggregateValues(query.op, b.values) ?? 0) : b.count,
          count: b.count,
          sortKey: b.sortKey,
        }))
        // Time buckets read chronologically; plain groups read
        // largest first with alphabetical tie-breaks.
        .sort((a, b) =>
          query.bucket
            ? a.sortKey.localeCompare(b.sortKey)
            : b.value - a.value || a.key.localeCompare(b.key),
        )
        .map(({ key, value, count }) => ({ key, value, count }));
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
      const rows = applyFilters(parsed, schema, query.filters);
      if (query.groupBy) {
        // Rank groups by the summed column (the "by revenue" in
        // "top 3 products by revenue"). With a time bucket the
        // groups are periods ("top 3 months by revenue").
        const gIdx = colIndex.get(query.groupBy)!;
        const cIdx = colIndex.get(query.column)!;
        const buckets = new Map<string, { label: string; sum: number; count: number }>();
        for (const row of rows) {
          const k = groupKey(row[gIdx] ?? "", query.bucket);
          const bucket = buckets.get(k.mapKey) ?? { label: k.label, sum: 0, count: 0 };
          bucket.count += 1;
          const raw = row[cIdx] ?? "";
          if (!isNullValue(raw)) {
            const n = toNumber(raw);
            if (n !== null) bucket.sum += n;
          }
          buckets.set(k.mapKey, bucket);
        }
        const groups = [...buckets.values()]
          .map((b) => ({ key: b.label, value: b.sum, count: b.count }))
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
      const rows = applyFilters(parsed, schema, query.filters);
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
      const rows = applyFilters(parsed, schema, query.filters);
      const shown = rows.slice(0, query.limit);
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
      };
    }

    case "share": {
      const rows = applyFilters(parsed, schema, query.filters);
      const totalRows = parsed.rows.length;
      if (query.column === null) {
        // Row-count share: the filtered rows as a fraction of all rows.
        return {
          kind: "share",
          column: null,
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
        subsetValue: subset.sum,
        totalValue: total.sum,
        share: total.sum === 0 ? null : subset.sum / total.sum,
        subsetRows: rows.length,
        totalRows,
        valuesUsed: subset.used,
        totalValuesUsed: total.used,
      };
    }

    case "comparison": {
      const dIdx = colIndex.get(query.dateColumn)!;
      const cIdx = query.column ? colIndex.get(query.column)! : -1;
      const rows = applyFilters(parsed, schema, query.filters);
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
  }
}
