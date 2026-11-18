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
 * - top-N: "top 3 products by revenue", "highest revenue"
 * - filters: "total revenue where region is North",
 *   "average salary where salary > 90000", "sales in North"
 * - rows: "show rows where region is North", "list employees in Data"
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

/**
 * Pull a "top N" / "largest N" / bare "highest|lowest" ranking out of
 * the question. A bare superlative means top 1. Returns the question
 * with the ranking words removed (normalized).
 */
function extractTop(text: string): {
  limit: number;
  direction: "highest" | "lowest";
  rest: string;
} | null {
  const norm = normalize(text);
  const numbered = /\b(top|largest|biggest|highest|smallest|lowest)\s+(\d+)\b/.exec(norm);
  if (numbered) {
    const direction = numbered[1] === "smallest" || numbered[1] === "lowest" ? "lowest" : "highest";
    return { limit: Number(numbered[2]), direction, rest: norm.replace(numbered[0], "").trim() };
  }
  const bare = /\b(highest|largest|biggest|smallest|lowest)\b/.exec(norm);
  if (bare) {
    const direction = bare[1] === "smallest" || bare[1] === "lowest" ? "lowest" : "highest";
    return { limit: 1, direction, rest: norm.replace(bare[0], "").trim() };
  }
  return null;
}

function distinctValues(parsed: ParsedCsv, colIndex: number): Set<string> {
  const vals = new Set<string>();
  for (const row of parsed.rows) {
    const v = (row[colIndex] ?? "").trim();
    if (v !== "" && vals.size < 500) vals.add(v.toLowerCase());
  }
  return vals;
}

interface FilterExtraction {
  filters: Filter[];
  rest: string;
  error?: string;
}

/**
 * Pull filters out of the question:
 * - a "where <column> <op> <value>" clause (is/=/>/>=/</<=, greater/less
 *   than, at least/at most, after/before, contains, is not), and
 * - a trailing "in <value>" / "for <value>" where the value is a known
 *   categorical value of exactly one column ("sales in North").
 * A bare value that belongs to several columns abstains — guessing
 * the column would answer a different question.
 */
function extractFilters(question: string, parsed: ParsedCsv): FilterExtraction {
  const columns = inferSchema(parsed);
  let rest = question;
  const filters: Filter[] = [];

  const where = /\bwhere\b/i.exec(rest);
  if (where) {
    const clause = rest.slice(where.index + where[0].length).trim();
    const opPatterns: { op: FilterOp; re: RegExp }[] = [
      { op: "!=", re: /^(.*?)\s+(?:is not|isn't|!=|not)\s+(.+)$/i },
      { op: ">=", re: /^(.*?)\s+(?:at least|>=)\s+(.+)$/i },
      { op: "<=", re: /^(.*?)\s+(?:at most|<=)\s+(.+)$/i },
      { op: ">", re: /^(.*?)\s+(?:greater than|more than|after|since|>)\s+(.+)$/i },
      { op: "<", re: /^(.*?)\s+(?:less than|fewer than|before|until|<)\s+(.+)$/i },
      { op: "contains", re: /^(.*?)\s+contains\s+(.+)$/i },
      { op: "=", re: /^(.*?)\s+(?:is|=|==|equals?)\s+(.+)$/i },
    ];
    let matched = false;
    for (const { op, re } of opPatterns) {
      const m = re.exec(clause);
      if (!m) continue;
      matched = true;
      const hits = findColumns(m[1], columns);
      if (hits.length === 0) {
        return {
          filters,
          rest,
          error: `could not find a column in "where ${clause}" — columns are: ${columns.map((c) => c.name).join(", ")}`,
        };
      }
      if (hits.length > 1) {
        return {
          filters,
          rest,
          error: `could not tell which column "where ${clause}" means — matches ${hits.map((c) => c.name).join(", ")}`,
        };
      }
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      filters.push({ column: hits[0].name, op, value });
      break;
    }
    if (!matched) {
      return {
        filters,
        rest,
        error: `could not understand the filter in "where ${clause}" — try e.g. "where region is North" or "where revenue > 100"`,
      };
    }
    rest = rest.slice(0, where.index).trim();
  }

  // Trailing "in <value>" / "for <value>" with a known categorical value.
  for (const marker of ["in", "for"]) {
    const re = new RegExp(`\\b${marker}\\s+([^,;]+?)\\s*$`, "i");
    const m = re.exec(rest);
    if (!m) continue;
    const value = m[1].trim().replace(/^["']|["']$/g, "");
    const owners = columns.filter((col, idx) => {
      if (col.type !== "text" && col.type !== "boolean") return false;
      return distinctValues(parsed, idx).has(value.toLowerCase());
    });
    if (owners.length === 1) {
      filters.push({ column: owners[0].name, op: "=", value });
      rest = rest.slice(0, m.index).trim();
    } else if (owners.length > 1) {
      return {
        filters,
        rest,
        error: `"${value}" appears in several columns (${owners.map((c) => c.name).join(", ")}) — say which one, e.g. "where ${owners[0].name} is ${value}"`,
      };
    }
    // No owner: not a filter (e.g. "for each department"); leave it.
  }

  return { filters, rest };
}

export function parseQuestion(question: string, parsed: ParsedCsv): ParseResult {
  if (!question || question.trim() === "") {
    return { ok: false, reason: "empty question — ask about a column, e.g. 'total revenue'" };
  }
  const columns = inferSchema(parsed);
  if (columns.length === 0) {
    return { ok: false, reason: "the sheet has no columns to ask about" };
  }

  const extracted = extractFilters(question, parsed);
  if (extracted.error) return { ok: false, reason: extracted.error };
  const filters = extracted.filters;

  // Top-N: "top 3 products by revenue" ranks groups by the column
  // named after "by"; without "by" it ranks rows by the one column
  // named in the question.
  const top = extractTop(extracted.rest);
  if (top) {
    const byIdx = top.rest.search(/\bby\b/);
    const rankPhrase = byIdx === -1 ? top.rest : top.rest.slice(byIdx + 2).trim();
    const groupPhrase = byIdx === -1 ? "" : top.rest.slice(0, byIdx).trim();
    const rankHits = findColumns(rankPhrase, columns);
    if (rankHits.length === 0) {
      return {
        ok: false,
        reason: `could not tell which column to rank by — columns are: ${columns.map((c) => c.name).join(", ")}`,
      };
    }
    if (rankHits.length > 1) {
      return {
        ok: false,
        reason: `could not tell which column to rank by — matches ${rankHits.map((c) => c.name).join(", ")}`,
      };
    }
    const rankColumn = rankHits[0];
    const groupHits = groupPhrase
      ? findColumns(groupPhrase, columns).filter((c) => c.name !== rankColumn.name)
      : [];
    if (groupHits.length > 1) {
      return {
        ok: false,
        reason: `could not tell which column to rank — matches ${groupHits.map((c) => c.name).join(", ")}`,
      };
    }
    return {
      ok: true,
      query: {
        kind: "top",
        column: rankColumn.name,
        limit: top.limit,
        direction: top.direction,
        groupBy: groupHits[0]?.name,
        filters,
      },
    };
  }

  const { groupBy, rest, ambiguous } = extractGroupBy(extracted.rest, columns);
  if (ambiguous.length > 0) {
    return {
      ok: false,
      reason: `could not tell which column to group by — matches ${ambiguous.join(", ")}`,
    };
  }
  const text = rest === "" ? extracted.rest : rest;

  // Count questions need no target column.
  if (isCountQuestion(text) && !groupBy) {
    return { ok: true, query: { kind: "count", filters } };
  }
  if (isCountQuestion(text) && groupBy) {
    return {
      ok: true,
      query: { kind: "group", groupBy: groupBy.name, column: null, op: "count", filters },
    };
  }

  const op = detectAggregateOp(text);
  // A question with a filter but no aggregate word asks for the
  // matching rows ("rows where region is North", "show sales in North").
  const normText = normalize(text);
  if (
    normText.startsWith("show") ||
    normText.startsWith("list") ||
    (filters.length > 0 && !op)
  ) {
    return { ok: true, query: { kind: "rows", filters, limit: 10 } };
  }
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
      query: { kind: "group", groupBy: groupBy.name, column: column.name, op, filters },
    };
  }
  return { ok: true, query: { kind: "aggregate", column: column.name, op, filters } };
}
