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
 * - time grouping: "total revenue by month", "average salary by year"
 *   (groups the sheet's date column into day/week/month/quarter/year
 *   periods; an unsupported period like "by decade" abstains)
 * - top-N: "top 3 products by revenue", "highest revenue"
 * - filters: "total revenue where region is North",
 *   "average salary where salary > 90000", "sales in North"
 * - rows: "show rows where region is North", "list employees in Data"
 * - correlation: "correlation between revenue and units",
 *   "how correlated are salary and age" (both columns must be numeric)
 * - period comparison: "compare revenue Jan 2026 vs Feb 2026",
 *   "revenue change from January to February" (two named months,
 *   quarters or years over the sheet's date column)
 */

import type { ParsedCsv } from "./csv.js";
import { inferSchema, type ColumnInfo } from "./schema.js";
import {
  BUCKET_WORDS,
  findPeriodMentions,
  parseDate,
  resolvePeriodYear,
  UNSUPPORTED_BUCKET_WORDS,
  type PeriodSpec,
  type TimeBucket,
} from "./time.js";

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
  | {
      kind: "group";
      groupBy: string;
      column: string | null;
      op: AggregateOp;
      filters: Filter[];
      /** When set, `groupBy` is a date column grouped into periods. */
      bucket?: TimeBucket;
    }
  | {
      kind: "top";
      column: string;
      limit: number;
      direction: "highest" | "lowest";
      groupBy?: string;
      filters: Filter[];
      bucket?: TimeBucket;
    }
  | { kind: "rows"; filters: Filter[]; limit: number }
  | { kind: "correlation"; columnA: string; columnB: string; filters: Filter[] }
  | {
      kind: "comparison";
      /** Null when comparing row counts ("compare rows in Jan vs Feb"). */
      column: string | null;
      op: AggregateOp;
      /** The date column the periods are read from. */
      dateColumn: string;
      periodA: PeriodSpec;
      periodB: PeriodSpec;
      filters: Filter[];
    };

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
 * Pull a "by <period>" / "per <period>" time clause out of the
 * question ("by month", "per year", "by quarterly"). A period word
 * the engine cannot bucket ("by decade", "by hour") is an error, not
 * something to silently ignore — answering the plain total would
 * answer a different question than the one asked. A "by <word>"
 * clause whose word is neither a period nor a time word (e.g. "by
 * region") is left alone for the group-by extractor.
 */
function extractTimeBucket(text: string): {
  bucket: TimeBucket | null;
  rest: string;
  error?: string;
} {
  const re = /\b(?:by|per)\s+([a-z]+)\b/gi;
  const matches: { index: number; length: number; word: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ index: m.index, length: m[0].length, word: m[1].toLowerCase() });
  }
  let bucket: TimeBucket | null = null;
  let rest = text;
  // Remove from the end so earlier indices stay valid.
  for (const match of [...matches].reverse()) {
    const word = match.word.endsWith("s") ? match.word.slice(0, -1) : match.word;
    const b = BUCKET_WORDS[match.word] ?? BUCKET_WORDS[word];
    if (b) {
      if (bucket) {
        return {
          bucket: null,
          rest: text,
          error: "group by one period at a time — e.g. 'by month', not 'by month by year'",
        };
      }
      bucket = b;
      rest = (rest.slice(0, match.index) + rest.slice(match.index + match.length))
        .replace(/\s+/g, " ")
        .trim();
    } else if (UNSUPPORTED_BUCKET_WORDS.has(match.word) || UNSUPPORTED_BUCKET_WORDS.has(word)) {
      return {
        bucket: null,
        rest: text,
        error: `I can't group by ${match.word} — try day, week, month, quarter or year`,
      };
    }
  }
  return { bucket, rest };
}

/**
 * Decide which date column a time bucket groups: the explicit
 * group-by column when one was named (it must be a date column), or
 * the sheet's only date column when none was named.
 */
function resolveBucketColumn(
  bucket: TimeBucket,
  groupBy: ColumnInfo | null,
  columns: ColumnInfo[],
): { column: ColumnInfo | null; error?: string } {
  if (groupBy) {
    if (groupBy.type !== "date") {
      return {
        column: null,
        error: `grouping by ${bucket} needs a date column — "${groupBy.name}" is ${groupBy.type}`,
      };
    }
    return { column: groupBy };
  }
  const dates = columns.filter((c) => c.type === "date");
  if (dates.length === 0) {
    return { column: null, error: `no date column to group by ${bucket}` };
  }
  if (dates.length > 1) {
    return {
      column: null,
      error: `could not tell which date column to group by ${bucket} — matches ${dates.map((c) => c.name).join(", ")}`,
    };
  }
  return { column: dates[0] };
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

/**
 * Try to read a correlation question ("correlation between revenue
 * and units", "how correlated are salary and age"). Returns null
 * when the question is not about correlation; otherwise a result —
 * a correlation query, or an abstention when the two columns cannot
 * be pinned down (fewer/more than two, or not numeric).
 */
function tryParseCorrelation(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\bcorrelat\w*\b/.test(norm)) return null;
  const stripped = norm
    .replace(/\bcorrelat\w*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hits = findColumns(stripped, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
  if (distinct.length < 2) {
    return {
      ok: false,
      reason: `correlation needs two columns named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (distinct.length > 2) {
    return {
      ok: false,
      reason: `could not tell which two columns to correlate — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  const nonNumeric = distinct.filter(
    (c) => c.type !== "integer" && c.type !== "number",
  );
  if (nonNumeric.length > 0) {
    return {
      ok: false,
      reason: `correlation needs two numeric columns — "${nonNumeric[0].name}" is ${nonNumeric[0].type}`,
    };
  }
  return {
    ok: true,
    query: {
      kind: "correlation",
      columnA: distinct[0].name,
      columnB: distinct[1].name,
      filters,
    },
  };
}

/**
 * Try to read a period-comparison question ("compare revenue Jan
 * 2026 vs Feb 2026", "revenue change from January to February",
 * "compare rows in Jan vs Feb"). Returns null when the question
 * shows no comparison intent; otherwise a comparison query, or an
 * abstention when the two periods or the target cannot be pinned
 * down. A bare column name defaults to its total ("compare revenue
 * Jan vs Feb" compares total revenue); a "rows" question compares
 * row counts.
 */
function tryParseComparison(
  text: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  const intent =
    /\bcompare\b/.test(norm) ||
    (/\b(change|growth|difference|increase|decrease)\b/.test(norm) &&
      /\bfrom\b/.test(norm));
  if (!intent) return null;

  const mentions = findPeriodMentions(norm);
  if (mentions.length !== 2) {
    return {
      ok: false,
      reason:
        "a comparison needs two periods named — e.g. 'compare revenue Jan 2026 vs Feb 2026'",
    };
  }
  const [first, second] = mentions;
  if (first.spec.bucket !== second.spec.bucket) {
    return {
      ok: false,
      reason: `compare like with like — two months, two quarters or two years, not ${first.spec.label} and ${second.spec.label}`,
    };
  }

  // The date column the periods are read from: the sheet's only one.
  const dates = columns.filter((c) => c.type === "date");
  if (dates.length === 0) {
    return {
      ok: false,
      reason: `comparing periods needs a date column — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (dates.length > 1) {
    return {
      ok: false,
      reason: `could not tell which date column to compare by — matches ${dates.map((c) => c.name).join(", ")}`,
    };
  }
  const dateColumn = dates[0];

  // Years actually present in the date column, for resolving a
  // period that did not name one ("January" on a 2026-only sheet).
  const dateIdx = columns.indexOf(dateColumn);
  const years: number[] = [];
  for (const row of parsed.rows) {
    const d = parseDate(row[dateIdx] ?? "");
    if (d) years.push(d.year);
  }
  const resolvedA = resolvePeriodYear(first.spec, years);
  if (resolvedA.error) return { ok: false, reason: resolvedA.error };
  const resolvedB = resolvePeriodYear(second.spec, years);
  if (resolvedB.error) return { ok: false, reason: resolvedB.error };
  const periodA = resolvedA.spec;
  const periodB = resolvedB.spec;
  if (periodA.key === periodB.key) {
    return {
      ok: false,
      reason: `both periods are ${periodA.label} — compare two different periods`,
    };
  }

  // Strip the period mentions and read the rest: an aggregate word
  // plus one column, or a bare "rows" for a row-count comparison.
  let rest = norm;
  for (const m of [...mentions].reverse()) {
    rest = (rest.slice(0, m.start) + " " + rest.slice(m.end)).replace(/\s+/g, " ").trim();
  }
  if (/\brows?\b/.test(rest) && findColumns(rest, columns).length === 0) {
    return {
      ok: true,
      query: {
        kind: "comparison",
        column: null,
        op: "count",
        dateColumn: dateColumn.name,
        periodA,
        periodB,
        filters,
      },
    };
  }
  const op = detectAggregateOp(rest) ?? "sum";
  const candidates = findColumns(rest, columns).filter((c) => c.name !== dateColumn.name);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to compare — matches ${candidates.map((c) => c.name).join(", ")}`,
    };
  }
  const column = candidates[0];
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `comparing needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  return {
    ok: true,
    query: {
      kind: "comparison",
      column: column.name,
      op,
      dateColumn: dateColumn.name,
      periodA,
      periodB,
      filters,
    },
  };
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

  // Period comparison: two named periods ("compare revenue Jan 2026
  // vs Feb 2026"). Once the question shows comparison intent it is
  // parsed here or abstained — falling through would answer the
  // plain total instead of the comparison asked for.
  const comparison = tryParseComparison(extracted.rest, columns, parsed, filters);
  if (comparison) return comparison;

  const timeBucket = extractTimeBucket(extracted.rest);
  if (timeBucket.error) return { ok: false, reason: timeBucket.error };
  const bucket = timeBucket.bucket;

  // Correlation: two numeric columns, no grouping or ranking.
  const correlation = tryParseCorrelation(timeBucket.rest, columns, filters);
  if (correlation) {
    if (bucket) {
      return {
        ok: false,
        reason: "correlation can't be grouped by a time period — ask about two columns, e.g. 'correlation between revenue and units'",
      };
    }
    return correlation;
  }

  // Top-N: "top 3 products by revenue" ranks groups by the column
  // named after "by"; without "by" it ranks rows by the one column
  // named in the question.
  const top = extractTop(timeBucket.rest);
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
    // A bare period word ranks the periods ("top 3 months by
    // revenue") — the grouped column is the sheet's date column.
    // A column actually named "months" still wins over the period.
    let topBucket: TimeBucket | undefined;
    let topGroupBy = groupHits[0]?.name;
    if (groupHits.length === 0 && groupPhrase) {
      const periodWord = normalize(groupPhrase);
      const periodBucket =
        BUCKET_WORDS[periodWord] ?? BUCKET_WORDS[singular(periodWord)];
      if (periodBucket) {
        if (bucket) {
          return {
            ok: false,
            reason: "group by one period at a time — e.g. 'by month', not 'by month by year'",
          };
        }
        const resolved = resolveBucketColumn(periodBucket, null, columns);
        if (resolved.error) return { ok: false, reason: resolved.error };
        topBucket = periodBucket;
        topGroupBy = resolved.column!.name;
      }
    }
    // A time bucket with a top-N question ranks the periods
    // ("top 3 products by revenue by month" is two-dimensional and
    // abstains — the grouped column must be a date column).
    if (bucket) {
      const resolved = resolveBucketColumn(bucket, groupHits[0] ?? null, columns);
      if (resolved.error) return { ok: false, reason: resolved.error };
      topBucket = bucket;
      topGroupBy = resolved.column!.name;
    }
    return {
      ok: true,
      query: {
        kind: "top",
        column: rankColumn.name,
        limit: top.limit,
        direction: top.direction,
        groupBy: topGroupBy,
        filters,
        bucket: topBucket,
      },
    };
  }

  const { groupBy, rest, ambiguous } = extractGroupBy(timeBucket.rest, columns);
  if (ambiguous.length > 0) {
    return {
      ok: false,
      reason: `could not tell which column to group by — matches ${ambiguous.join(", ")}`,
    };
  }
  // A time bucket needs a date column to group: the explicit
  // group-by column when one was named, else the sheet's only date
  // column.
  let resolvedGroupBy = groupBy;
  if (bucket) {
    const resolved = resolveBucketColumn(bucket, groupBy, columns);
    if (resolved.error) return { ok: false, reason: resolved.error };
    resolvedGroupBy = resolved.column;
  }
  const text = rest === "" ? timeBucket.rest : rest;

  // Count questions need no target column.
  if (isCountQuestion(text) && !resolvedGroupBy) {
    return { ok: true, query: { kind: "count", filters } };
  }
  if (isCountQuestion(text) && resolvedGroupBy) {
    return {
      ok: true,
      query: {
        kind: "group",
        groupBy: resolvedGroupBy.name,
        column: null,
        op: "count",
        filters,
        bucket: bucket ?? undefined,
      },
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
    (c) => !resolvedGroupBy || c.name !== resolvedGroupBy.name,
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

  if (resolvedGroupBy) {
    return {
      ok: true,
      query: {
        kind: "group",
        groupBy: resolvedGroupBy.name,
        column: column.name,
        op,
        filters,
        bucket: bucket ?? undefined,
      },
    };
  }
  return { ok: true, query: { kind: "aggregate", column: column.name, op, filters } };
}
