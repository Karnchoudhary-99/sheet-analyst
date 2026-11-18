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
 *   then by key (ascending) so ties are stable.
 */

import type { ParsedCsv } from "./csv.js";
import type { Filter, Query } from "./query.js";
import { inferSchema, isNullValue, type ColumnInfo } from "./schema.js";
import { numericStats } from "./stats.js";

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
    }
  | {
      kind: "rows";
      headers: string[];
      rows: Record<string, string>[];
      totalMatched: number;
      limitedTo?: number;
    };

function toNumber(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toEpoch(value: string): number | null {
  const v = value.trim();
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  const ms = dmy
    ? Date.parse(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`)
    : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
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
      const buckets = new Map<string, { values: number[]; count: number }>();
      for (const row of rows) {
        const key = (row[gIdx] ?? "").trim() === "" ? "(blank)" : (row[gIdx] ?? "").trim();
        const bucket = buckets.get(key) ?? { values: [], count: 0 };
        bucket.count += 1;
        if (cIdx >= 0) {
          const raw = row[cIdx] ?? "";
          if (!isNullValue(raw)) {
            const n = toNumber(raw);
            if (n !== null) bucket.values.push(n);
          }
        }
        buckets.set(key, bucket);
      }
      const groups = [...buckets.entries()]
        .map(([key, b]) => ({
          key,
          value: query.column ? (aggregateValues(query.op, b.values) ?? 0) : b.count,
          count: b.count,
        }))
        // Largest group first; ties break alphabetically so output is stable.
        .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
      return {
        kind: "groups",
        groupBy: query.groupBy,
        column: query.column,
        op: query.op,
        groups,
        rowsMatched: rows.length,
        totalGroups: groups.length,
      };
    }

    case "top": {
      const rows = applyFilters(parsed, schema, query.filters);
      if (query.groupBy) {
        // Rank groups by the summed column (the "by revenue" in
        // "top 3 products by revenue").
        const gIdx = colIndex.get(query.groupBy)!;
        const cIdx = colIndex.get(query.column)!;
        const buckets = new Map<string, { sum: number; count: number }>();
        for (const row of rows) {
          const key = (row[gIdx] ?? "").trim() === "" ? "(blank)" : (row[gIdx] ?? "").trim();
          const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
          bucket.count += 1;
          const raw = row[cIdx] ?? "";
          if (!isNullValue(raw)) {
            const n = toNumber(raw);
            if (n !== null) bucket.sum += n;
          }
          buckets.set(key, bucket);
        }
        const groups = [...buckets.entries()]
          .map(([key, b]) => ({ key, value: b.sum, count: b.count }))
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
  }
}
