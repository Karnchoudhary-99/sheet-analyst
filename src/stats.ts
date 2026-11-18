/**
 * Descriptive statistics per column: numeric summaries for number /
 * integer / date columns, value frequencies for text / boolean ones.
 * All math is population statistics (divide by N) and is documented
 * as such in the output so answers stay reproducible.
 */

import type { ParsedCsv } from "./csv.js";
import { inferSchema, isNullValue, type ColumnInfo } from "./schema.js";

export interface NumericStats {
  kind: "numeric";
  count: number;
  nullCount: number;
  distinctCount: number;
  min: number;
  max: number;
  sum: number;
  mean: number;
  median: number;
  stddev: number;
}

export interface CategoricalStats {
  kind: "categorical";
  count: number;
  nullCount: number;
  distinctCount: number;
  /** Top values by frequency, most common first, capped at 10. */
  top: { value: string; count: number }[];
}

export type ColumnStats = NumericStats | CategoricalStats;

export function numericStats(values: number[]): Pick<
  NumericStats,
  "min" | "max" | "sum" | "mean" | "median" | "stddev"
> {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance =
    sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  return {
    min: sorted[0],
    max: sorted[n - 1],
    sum,
    mean,
    median,
    stddev: Math.sqrt(variance),
  };
}

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

export function describeColumn(
  values: string[],
  info: ColumnInfo,
): ColumnStats {
  const present = values.filter((v) => !isNullValue(v));
  const nullCount = values.length - present.length;
  const distinctCount = new Set(present).size;
  if (info.type === "integer" || info.type === "number") {
    const nums = present
      .map(toNumber)
      .filter((n): n is number => n !== null);
    return {
      kind: "numeric",
      count: nums.length,
      nullCount,
      distinctCount,
      ...numericStats(nums),
    };
  }
  if (info.type === "date") {
    const epochs = present
      .map(toEpoch)
      .filter((n): n is number => n !== null);
    const stats = numericStats(epochs);
    return {
      kind: "numeric",
      count: epochs.length,
      nullCount,
      distinctCount,
      min: stats.min,
      max: stats.max,
      sum: stats.sum,
      mean: stats.mean,
      median: stats.median,
      stddev: stats.stddev,
    };
  }
  const freq = new Map<string, number>();
  for (const v of present) freq.set(v, (freq.get(v) ?? 0) + 1);
  const top = [...freq.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 10);
  return { kind: "categorical", count: present.length, nullCount, distinctCount, top };
}

export function describe(parsed: ParsedCsv): { name: string; stats: ColumnStats }[] {
  const schema = inferSchema(parsed);
  return schema.map((info, col) => ({
    name: info.name,
    stats: describeColumn(
      parsed.rows.map((r) => r[col] ?? ""),
      info,
    ),
  }));
}
