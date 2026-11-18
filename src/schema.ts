/**
 * Schema inference: guess each column's type from its values.
 *
 * Types, in the order they are tried: boolean, integer, number, date,
 * text. A value is null when it is empty or one of the common missing
 * markers (`null`, `NA`, `N/A`, `-`). Dates accept ISO dates/datetimes
 * and DD/MM/YYYY (day-first, documented — ambiguous MM/DD/YYYY input
 * is read day-first). A column with no non-null values is `empty`.
 */

import type { ParsedCsv } from "./csv.js";

export type ColumnType =
  | "boolean"
  | "integer"
  | "number"
  | "date"
  | "text"
  | "empty";

export interface ColumnInfo {
  name: string;
  type: ColumnType;
  /** Non-null values seen, capped at 5, in file order. */
  sample: string[];
  nullCount: number;
  distinctCount: number;
}

export const NULL_MARKERS = new Set(["", "null", "na", "n/a", "-"]);

export function isNullValue(value: string): boolean {
  return NULL_MARKERS.has(value.trim().toLowerCase());
}

const BOOLEAN_WORDS = new Set([
  "true",
  "false",
  "yes",
  "no",
  "y",
  "n",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DMY_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isDateValue(value: string): boolean {
  const v = value.trim();
  if (ISO_DATE.test(v)) return true;
  const m = DMY_DATE.exec(v);
  if (!m) return false;
  const day = Number(m[1]);
  const month = Number(m[2]);
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

function parseNumber(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  if (cleaned === "" || /[^0-9.+\-eE]/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function inferColumnType(values: string[]): ColumnType {
  const present = values.filter((v) => !isNullValue(v));
  if (present.length === 0) return "empty";
  const lowered = present.map((v) => v.trim().toLowerCase());
  if (lowered.every((v) => BOOLEAN_WORDS.has(v))) return "boolean";
  const numbers = present.map(parseNumber);
  if (numbers.every((n) => n !== null)) {
    return (numbers as number[]).every(Number.isInteger)
      ? "integer"
      : "number";
  }
  if (present.every(isDateValue)) return "date";
  return "text";
}

export function inferSchema(parsed: ParsedCsv): ColumnInfo[] {
  return parsed.headers.map((name, col) => {
    const values = parsed.rows.map((r) => r[col] ?? "");
    const present = values.filter((v) => !isNullValue(v));
    return {
      name,
      type: inferColumnType(values),
      sample: present.slice(0, 5),
      nullCount: values.length - present.length,
      distinctCount: new Set(present).size,
    };
  });
}
