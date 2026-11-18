/**
 * Data-quality profile: what is wrong (or suspicious) about a sheet
 * before anyone trusts an answer computed from it.
 *
 * A profile reports, per sheet and per column:
 *   - null rates (how much of each column is missing)
 *   - duplicate rows and fully-empty rows
 *   - constant columns (a single distinct value — usually a dead column)
 *   - cells with leading/trailing whitespace (a classic silent join
 *     breaker: "Paris" and "Paris " look identical but are not)
 *   - numeric outliers by the Tukey IQR fence (1.5 x IQR outside Q1/Q3)
 *
 * Nothing here guesses: every number is counted from the parsed rows,
 * and the warnings are plain sentences naming the column and the count.
 */

import type { ParsedCsv } from "./csv.js";
import { inferSchema, isNullValue, type ColumnType } from "./schema.js";

export interface OutlierSummary {
  /** Rows outside the Tukey fence. */
  count: number;
  /** Smallest / largest outlier actually seen. */
  low: number;
  high: number;
  /** The fence bounds themselves (values beyond these are outliers). */
  lowBound: number;
  highBound: number;
}

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  nullCount: number;
  /** Share of rows that are null in this column, 0–1. */
  nullRate: number;
  distinctCount: number;
  /** Share of present values that are distinct, 0–1 (0 when all null). */
  distinctRate: number;
  /** True when exactly one distinct non-null value exists. */
  constant: boolean;
  /** Non-null cells with leading or trailing whitespace. */
  whitespaceCells: number;
  /** Only for numeric columns with at least 4 values. */
  outliers?: OutlierSummary;
}

export interface SheetProfile {
  rows: number;
  columnCount: number;
  /** Rows after the first occurrence of an identical row. */
  duplicateRows: number;
  /** Rows where every cell is a null value. */
  emptyRows: number;
  columns: ColumnProfile[];
  /** Human-readable warnings, in sheet order then column order. */
  warnings: string[];
}

/** Median of a sorted array (population median, same as stats.ts). */
function medianOf(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Tukey IQR fence outliers for sorted numeric values; null below 4 values. */
export function iqrOutliers(sortedValues: number[]): OutlierSummary | null {
  const sorted = [...sortedValues].sort((a, b) => a - b);
  if (sorted.length < 4) return null;
  const lowerHalf = sorted.slice(0, Math.floor(sorted.length / 2));
  const upperHalf = sorted.slice(Math.ceil(sorted.length / 2));
  const q1 = medianOf(lowerHalf);
  const q3 = medianOf(upperHalf);
  const iqr = q3 - q1;
  // A zero IQR means the middle half is one value: any different value
  // is outside the fence, which is the honest reading, not a bug.
  const lowBound = q1 - 1.5 * iqr;
  const highBound = q3 + 1.5 * iqr;
  const outside = sorted.filter((v) => v < lowBound || v > highBound);
  if (outside.length === 0) return null;
  return {
    count: outside.length,
    low: outside[0],
    high: outside[outside.length - 1],
    lowBound,
    highBound,
  };
}

function toNumber(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function profileColumn(
  values: string[],
  name: string,
  type: ColumnType,
): ColumnProfile {
  const present = values.filter((v) => !isNullValue(v));
  const nullCount = values.length - present.length;
  const distinctCount = new Set(present).size;
  const profile: ColumnProfile = {
    name,
    type,
    nullCount,
    nullRate: values.length === 0 ? 0 : nullCount / values.length,
    distinctCount,
    distinctRate: present.length === 0 ? 0 : distinctCount / present.length,
    constant: distinctCount === 1,
    whitespaceCells: present.filter((v) => v !== v.trim()).length,
  };
  if (type === "integer" || type === "number") {
    const nums = present
      .map(toNumber)
      .filter((n): n is number => n !== null);
    const outliers = iqrOutliers(nums);
    if (outliers) profile.outliers = outliers;
  }
  return profile;
}

export function profileSheet(parsed: ParsedCsv): SheetProfile {
  const schema = inferSchema(parsed);
  const seen = new Set<string>();
  let duplicateRows = 0;
  let emptyRows = 0;
  for (const row of parsed.rows) {
    if (row.every((cell) => isNullValue(cell ?? ""))) emptyRows += 1;
    const key = row.map((cell) => cell ?? "").join("\u0000");
    if (seen.has(key)) duplicateRows += 1;
    else seen.add(key);
  }
  const columns = schema.map((info, col) =>
    profileColumn(
      parsed.rows.map((r) => r[col] ?? ""),
      info.name,
      info.type,
    ),
  );
  const warnings: string[] = [];
  if (duplicateRows > 0) {
    warnings.push(
      `${duplicateRows} duplicate ${duplicateRows === 1 ? "row" : "rows"}`,
    );
  }
  if (emptyRows > 0) {
    warnings.push(`${emptyRows} empty ${emptyRows === 1 ? "row" : "rows"}`);
  }
  for (const col of columns) {
    if (col.nullRate >= 0.5 && col.nullCount > 0) {
      warnings.push(
        `"${col.name}" is ${Math.round(col.nullRate * 100)}% null`,
      );
    }
    if (col.constant && col.nullCount < parsed.rows.length) {
      warnings.push(`"${col.name}" has a single distinct value`);
    }
    if (col.whitespaceCells > 0) {
      warnings.push(
        `"${col.name}" has ${col.whitespaceCells} ${col.whitespaceCells === 1 ? "cell" : "cells"} with leading/trailing whitespace`,
      );
    }
    if (col.outliers) {
      warnings.push(
        `"${col.name}" has ${col.outliers.count} outlier${col.outliers.count === 1 ? "" : "s"} outside [${col.outliers.lowBound}, ${col.outliers.highBound}]`,
      );
    }
  }
  return {
    rows: parsed.rows.length,
    columnCount: schema.length,
    duplicateRows,
    emptyRows,
    columns,
    warnings,
  };
}
