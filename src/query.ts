/**
 * Natural-language question parsing: turn a plain-English question
 * about a spreadsheet into a structured {@link Query} the engine can
 * run. The parser is deterministic and offline — no LLM, no guessing.
 *
 * When a question cannot be understood unambiguously the parser
 * abstains (`{ ok: false, reason }`) instead of answering a different
 * question than the one asked. The answer composer surfaces the
 * reason so the user can rephrase.
 *
 * Supported shapes (column names are matched case-insensitively,
 * with `_` treated as a space, and singular/plural tolerated):
 * - aggregates: "total revenue", "average salary", "median age",
 *   "highest revenue", "lowest salary"
 * - counts: "how many employees", "how many rows"
 * - group-by: "total revenue by region", "average salary per department"
 */

import type { ParsedCsv } from "./csv.js";
import { inferSchema, type ColumnInfo } from "./schema.js";

export type AggregateOp = "sum" | "mean" | "median" | "min" | "max" | "count";

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";

export interface Filter {
  column: string;
  op: FilterOp;
  /** Raw value as written in the question (quotes stripped). */
  value: string;
}

export type Query =
  | { kind: "aggregate"; column: string; op: Exclude<AggregateOp, "count">; filters: Filter[] }
  | { kind: "count"; filters: Filter[] }
  | { kind: "group"; groupBy: string; column: string | null; op: AggregateOp; filters: Filter[] }
  | { kind: "top"; column: string; limit: number; direction: "highest" | "lowest"; groupBy?: string; filters: Filter[] }
  | { kind: "rows"; filters: Filter[]; limit: number };

export type ParseResult =
  | { ok: true; query: Query }
  | { ok: false; reason: string };

/** Lowercase, collapse punctuation/underscores to spaces, trim. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singular(word: string): string {
  return word.endsWith("s") && word.length > 1 ? word.slice(0, -1) : word;
}

/**
 * All columns whose normalized name appears in the normalized phrase,
 * allowing a trailing-s difference on either side. Sorted by name
 * length (longest first) so "start date" wins over "date".
 */
export function findColumns(phrase: string, columns: ColumnInfo[]): ColumnInfo[] {
  const text = normalize(phrase);
  const hits: ColumnInfo[] = [];
  for (const col of columns) {
    const name = normalize(col.name);
    const nameSingular = name.split(" ").map(singular).join(" ");
    const textSingular = text.split(" ").map(singular).join(" ");
    if (
      text.includes(name) ||
      text.includes(nameSingular) ||
      textSingular.includes(name) ||
      textSingular.includes(nameSingular)
    ) {
      hits.push(col);
    }
  }
  return hits.sort((a, b) => b.name.length - a.name.length);
}

const AGGREGATE_WORDS: { op: Exclude<AggregateOp, "count">; words: string[] }[] = [
  { op: "sum", words: ["total", "sum", "combined"] },
  { op: "mean", words: ["average", "mean", "avg"] },
  { op: "median", words: ["median"] },
  { op: "max", words: ["maximum", "highest", "largest", "greatest", "max", "biggest"] },
  { op: "min", words: ["minimum", "lowest", "smallest", "least", "min"] },
];

function detectAggregateOp(text: string): Exclude<AggregateOp, "count"> | null {
  const words = new Set(normalize(text).split(" "));
  for (const { op, words: keys } of AGGREGATE_WORDS) {
    if (keys.some((w) => words.has(w))) return op;
  }
  return null;
}

function isCountQuestion(text: string): boolean {
  const norm = normalize(text);
  return (
    norm.startsWith("how many") ||
    norm.startsWith("count of") ||
    norm.startsWith("count the") ||
    norm.startsWith("number of") ||
    /\bhow many\b/.test(norm)
  );
}

/**
 * Pull a "by <column>" / "per <column>" / "for each <column>" clause
 * out of the question. Returns the group-by column (if exactly one
 * column is named that way) and the question with the clause removed.
 */
function extractGroupBy(
  text: string,
  columns: ColumnInfo[],
): { groupBy: ColumnInfo | null; rest: string; ambiguous: string[] } {
  const norm = normalize(text);
  for (const marker of ["grouped by", "group by", "for each", "per", "by"]) {
    const re = new RegExp(`\\b${marker.replace(" ", "\\s+")}\\b`);
    const m = re.exec(norm);
    if (!m) continue;
    const idx = m.index;
    const tail = norm.slice(idx + m[0].length).trim();
    const hits = findColumns(tail, columns);
    if (hits.length === 1) {
      const before = norm.slice(0, idx).trim();
      return { groupBy: hits[0], rest: before, ambiguous: [] };
    }
    if (hits.length > 1) {
      return {
        groupBy: null,
        rest: text,
        ambiguous: hits.map((c) => c.name),
      };
    }
  }
  return { groupBy: null, rest: text, ambiguous: [] };
}

export function parseQuestion(question: string, parsed: ParsedCsv): ParseResult {
  if (!question || question.trim() === "") {
    return { ok: false, reason: "empty question — ask about a column, e.g. 'total revenue'" };
  }
  const columns = inferSchema(parsed);
  if (columns.length === 0) {
    return { ok: false, reason: "the sheet has no columns to ask about" };
  }

  const { groupBy, rest, ambiguous } = extractGroupBy(question, columns);
  if (ambiguous.length > 0) {
    return {
      ok: false,
      reason: `could not tell which column to group by — matches ${ambiguous.join(", ")}`,
    };
  }
  const text = rest === "" ? question : rest;

  // Count questions need no target column.
  if (isCountQuestion(text) && !groupBy) {
    return { ok: true, query: { kind: "count", filters: [] } };
  }
  if (isCountQuestion(text) && groupBy) {
    return {
      ok: true,
      query: { kind: "group", groupBy: groupBy.name, column: null, op: "count", filters: [] },
    };
  }

  const op = detectAggregateOp(text);
  if (!op) {
    return {
      ok: false,
      reason:
        "I can answer totals, averages, medians, minimums, maximums and counts — " +
        "try e.g. 'total revenue' or 'average salary by department'",
    };
  }

  // The target column is the one named in the question, excluding the
  // group-by column (already consumed).
  const candidates = findColumns(text, columns).filter(
    (c) => !groupBy || c.name !== groupBy.name,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column you mean — matches ${candidates.map((c) => c.name).join(", ")}`,
    };
  }
  const column = candidates[0];

  if (groupBy) {
    return {
      ok: true,
      query: { kind: "group", groupBy: groupBy.name, column: column.name, op, filters: [] },
    };
  }
  return { ok: true, query: { kind: "aggregate", column: column.name, op, filters: [] } };
}
