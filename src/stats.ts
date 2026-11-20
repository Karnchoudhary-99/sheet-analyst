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
  /** First quartile (25th percentile, linear interpolation). */
  q1: number;
  /** Third quartile (75th percentile, linear interpolation). */
  q3: number;
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

/**
 * Percentile of a pre-sorted array by linear interpolation between
 * the two nearest ranks (the same method as numpy's default): the
 * rank is `p * (n - 1)`, so the median of an even-length sample is
 * the average of the two middle values, matching `numericStats`.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty array");
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** "1st", "2nd", "3rd", "90th" — the label for a percentile question. */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

export function numericStats(values: number[]): Pick<
  NumericStats,
  "min" | "max" | "sum" | "mean" | "median" | "q1" | "q3" | "stddev"
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
    q1: percentile(sorted, 0.25),
    q3: percentile(sorted, 0.75),
    stddev: Math.sqrt(variance),
  };
}

/**
 * Pearson correlation coefficient between two paired series, or
 * null when it cannot be computed: fewer than two pairs, or either
 * series constant (zero variance makes the denominator zero, so
 * there is no correlation to report — not a zero correlation).
 */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
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
      q1: stats.q1,
      q3: stats.q3,
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
