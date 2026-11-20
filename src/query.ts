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
 * - multi-column group-by: "total revenue by region and product",
 *   "how many employees by department and remote" (up to three
 *   columns, in the order named; "by region, product" works too)
 * - time grouping: "total revenue by month", "average salary by year"
 *   (groups the sheet's date column into day/week/month/quarter/year
 *   periods; an unsupported period like "by decade" abstains)
 * - top-N: "top 3 products by revenue", "highest revenue"
 *   (also over several columns: "top 3 region and product by
 *   revenue")
 * - bottom-N: "bottom 3 products by revenue", "bottom 2 months by
 *   revenue", "bottom revenue" (the same ranking, smallest first;
 *   "lowest" already meant this — "bottom" is the word people
 *   actually say)
 * - filters: "total revenue where region is North",
 *   "average salary where salary > 90000", "sales in North"
 * - rows: "show rows where region is North", "list employees in Data"
 * - sorted rows: "show rows sorted by revenue descending",
 *   "list employees sorted by salary ascending" (numbers sort
 *   numerically, dates by day, text alphabetically; blank cells
 *   always sort last; no direction means ascending)
 * - correlation: "correlation between revenue and units",
 *   "how correlated are salary and age" (both columns must be numeric)
 * - period comparison: "compare revenue Jan 2026 vs Feb 2026",
 *   "revenue change from January to February" (two named months,
 *   quarters or years over the sheet's date column)
 * - share: "what share of revenue is North", "what percentage of
 *   total revenue comes from North" (a filtered subset's total as a
 *   share of the whole sheet's total), "what share of rows are in
 *   North" (a filtered row count as a share of all rows)
 * - distinct values: "list unique regions", "what are the distinct
 *   products" (every distinct value of a column, with row counts,
 *   most frequent first)
 * - mode: "most common product", "what is the mode of region" (the
 *   value that appears most often; ties break alphabetically)
 * - distinct count: "how many distinct regions", "count distinct
 *   products" (how many different values a column has, blanks excluded)
 * - percentile: "90th percentile of salary", "p90 revenue" (linear
 *   interpolation, the same method as the quartiles in describe)
 * - range filter: "where revenue between 100 and 200" (inclusive on
 *   both ends; the smaller value must come first)
 * - trend: "revenue trend by month", "average salary trend by year"
 *   (least-squares slope of the per-period aggregate over time; a
 *   trend needs a period and one numeric column)
 * - above/below average: "rows with revenue above average",
 *   "which employees have salary below the median" (rows whose
 *   value is strictly above or below the sheet's mean or median
 *   for that column; a column with no usable value has no baseline
 *   and the answer says so)
 * - missing values: "how many rows are missing salary", "which
 *   columns have missing values" (a count per column, or a
 *   whole-sheet report over every column), "show rows missing
 *   revenue" (the rows themselves, first 10)
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

/**
 * A row-listing sort: which column to order by, and which way.
 * Ascending is the default when the question names no direction.
 */
export interface SortSpec {
  column: string;
  direction: "asc" | "desc";
}

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
      /** One or more columns, in the order named in the question. */
      groupBy: string[];
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
      /** One or more columns to rank ("top 3 region and product by revenue"). */
      groupBy?: string[];
      filters: Filter[];
      bucket?: TimeBucket;
    }
  | { kind: "rows"; filters: Filter[]; limit: number; sort?: SortSpec }
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
    }
  | {
      kind: "share";
      /**
       * The column being shared out, or null for a row-count share
       * ("what share of rows are in North"). A value share always
       * compares totals (sum), never averages — a share of an average
       * is not a meaningful fraction of anything.
       */
      column: string | null;
      /** The subset whose share is asked for (at least one filter). */
      filters: Filter[];
    }
  | {
      kind: "distinct";
      /** The column whose distinct values are listed. */
      column: string;
      filters: Filter[];
      /** Most values shown (default 20); the result reports the total. */
      limit: number;
    }
  | {
      kind: "mode";
      /** The column whose most frequent value is asked for. */
      column: string;
      filters: Filter[];
    }
  | {
      kind: "distinctCount";
      /** The column whose number of distinct values is asked for. */
      column: string;
      filters: Filter[];
    }
  | {
      kind: "percentile";
      /** The column the percentile is read from. */
      column: string;
      /** 1–99: "90th percentile" is p = 90. */
      p: number;
      filters: Filter[];
    }
  | {
      kind: "trend";
      /** The column being trended. */
      column: string;
      /** Default sum ("revenue trend" trends the total revenue). */
      op: Exclude<AggregateOp, "count">;
      /** The date column the periods are read from. */
      dateColumn: string;
      /** The period the aggregates are bucketed into. */
      bucket: TimeBucket;
      filters: Filter[];
    }
  | {
      kind: "aboveBelow";
      /** The numeric column compared against its own baseline. */
      column: string;
      /** Strictly above, or strictly below, the baseline. */
      direction: "above" | "below";
      /** Mean or median of the column over the matched rows. */
      baseline: "average" | "median";
      filters: Filter[];
    }
  | {
      kind: "missing";
      /**
       * The column to check, or null for a whole-sheet report over
       * every column ("which columns have missing values").
       * A "missing value" is what the schema calls null: empty, or
       * a marker like NA or N/A.
       */
      column: string | null;
      filters: Filter[];
      /**
       * True for "show rows missing <column>": list the rows
       * themselves instead of counting them.
       */
      listRows: boolean;
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

interface ColumnSpan {
  col: ColumnInfo;
  start: number;
  len: number;
}

/**
 * Columns named in a phrase, in the order they appear, with a
 * column whose name sits inside another matched column's name
 * dropped ("start date" is one column, not "start date" plus
 * "date"). Shared by the group-by extractor and the top-N parser.
 */
function matchColumnsInOrder(phrase: string, columns: ColumnInfo[]): ColumnSpan[] {
  const text = normalize(phrase);
  const hits = findColumns(phrase, columns);
  const spans = hits
    .map((col) => {
      const name = normalize(col.name);
      const nameSingular = name.split(" ").map(singular).join(" ");
      const textSingular = text.split(" ").map(singular).join(" ");
      let start = text.indexOf(name);
      let len = name.length;
      if (start === -1) {
        start = textSingular.indexOf(nameSingular);
        len = nameSingular.length;
      }
      return { col, start, len };
    })
    .filter((s) => s.start >= 0)
    .sort((a, b) => a.start - b.start || b.len - a.len);
  const kept: ColumnSpan[] = [];
  for (const s of spans) {
    const overlaps = kept.some(
      (k) => s.start < k.start + k.len && k.start < s.start + s.len,
    );
    if (!overlaps) kept.push(s);
  }
  return kept;
}

/**
 * Pull a "by <column>" / "per <column>" / "for each <column>" clause
 * out of the question. Several columns may be named ("by region and
 * product", "by region, product") — they group in the order named,
 * up to three at a time. Returns the group-by columns (empty when
 * none was named) and the question with the clause removed.
 *
 * Two honesty guards live here, because a wrong group is worse than
 * no answer:
 * - a column named inside another matched column's name does not
 *   count twice ("by start date" is one column, not "start date"
 *   plus "date");
 * - a word left in the clause that is not a matched column name is
 *   a column the sheet does not have — the question abstains
 *   ("by region and profit" must not answer as "by region").
 */
/**
 * Pull a "sorted by <column> [ascending|descending]" clause out of
 * the question ("show rows sorted by revenue descending", "list
 * employees sorted by salary"). Returns the sort spec plus the
 * question with the clause removed, or an error when the sort column
 * cannot be pinned down. No sort phrase returns the text untouched.
 * The direction defaults to ascending.
 *
 * This runs on the raw question BEFORE the filter extractor: a
 * "where" value would otherwise swallow the sort phrase ("where
 * region is North sorted by revenue" reads the value as "North
 * sorted by revenue descending"). It also runs before the group-by
 * extractor, which would read "sorted by revenue" as a group-by on
 * revenue and report the direction word ("descending") as an
 * unknown column. The match is case-insensitive and works on the
 * raw text (not the normalized form) so the remaining question
 * keeps its original casing for the filter extractor — filter
 * values keep their spelling ("North", not "north").
 *
 * The sort phrase may sit before a "where" clause ("sorted by
 * revenue where region is North"): the lookahead stops the match
 * at "where" and the clause is kept in the returned text.
 */
function extractSort(
  text: string,
  columns: ColumnInfo[],
): { sort: SortSpec | null; rest: string; error?: string } {
  const m =
    /\b(?:sorted|sort|ordered|order)\s+by\s+([a-z0-9_ ]+?)(?:\s+(ascending|descending|asc|desc))?(?=\s+where\b|\s*$)/i.exec(
      text,
    );
  if (!m) return { sort: null, rest: text };
  const columnPhrase = m[1]!.trim();
  const direction: "asc" | "desc" =
    m[2] !== undefined &&
    (m[2].toLowerCase() === "descending" || m[2].toLowerCase() === "desc")
      ? "desc"
      : "asc";
  const hits = findColumns(columnPhrase, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
  if (distinct.length === 0) {
    return {
      sort: null,
      rest: text,
      error: `could not find a column to sort by — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (distinct.length > 1) {
    return {
      sort: null,
      rest: text,
      error: `could not tell which column to sort by — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { sort: { column: distinct[0]!.name, direction }, rest };
}

function extractGroupBy(
  text: string,
  columns: ColumnInfo[],
): { groupBy: ColumnInfo[]; rest: string; error?: string } {
  const norm = normalize(text);
  for (const marker of ["grouped by", "group by", "for each", "per", "by"]) {
    const re = new RegExp(`\\b${marker.replace(" ", "\\s+")}\\b`);
    const m = re.exec(norm);
    if (!m) continue;
    const idx = m.index;
    const tail = norm.slice(idx + m[0].length).trim();
    const kept = matchColumnsInOrder(tail, columns);
    if (kept.length === 0) continue;
    if (kept.length > 3) {
      return {
        groupBy: [],
        rest: text,
        error:
          "group by at most three columns at a time — e.g. 'by region and product'",
      };
    }
    // Any word left in the tail that is not a matched column name
    // and not the "and"/"per"/"by" joiner is a column the sheet
    // does not have — refuse rather than silently dropping it.
    let leftover = tail;
    for (const k of [...kept].sort((a, b) => b.start - a.start)) {
      leftover = (leftover.slice(0, k.start) + " " + leftover.slice(k.start + k.len))
        .replace(/\s+/g, " ")
        .trim();
    }
    const filler = new Set(["and", "per", "by", "grouped", "group", "each", "for"]);
    const stray = leftover.split(" ").filter((w) => w !== "" && !filler.has(w));
    if (stray.length > 0) {
      return {
        groupBy: [],
        rest: text,
        error: `could not find a column named "${stray.join(" ")}" — columns are: ${columns.map((c) => c.name).join(", ")}`,
      };
    }
    const before = norm.slice(0, idx).trim();
    return { groupBy: kept.map((k) => k.col), rest: before };
  }
  return { groupBy: [], rest: text };
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
 * Pull a "top N" / "bottom N" / "largest N" / bare "highest|lowest"
 * ranking out of the question. A bare superlative means top 1.
 * "bottom" is the low end of the same ranking ("bottom 3 products
 * by revenue" ranks ascending); "least" stays an aggregate word
 * ("least revenue" is the minimum, a scalar — see detectAggregateOp),
 * not a ranking, so it is deliberately not matched here. Returns the
 * question with the ranking words removed (normalized).
 */
function extractTop(text: string): {
  limit: number;
  direction: "highest" | "lowest";
  rest: string;
} | null {
  const norm = normalize(text);
  const numbered = /\b(top|largest|biggest|highest|smallest|lowest|bottom)\s+(\d+)\b/.exec(norm);
  if (numbered) {
    const direction =
      numbered[1] === "smallest" || numbered[1] === "lowest" || numbered[1] === "bottom"
        ? "lowest"
        : "highest";
    return { limit: Number(numbered[2]), direction, rest: norm.replace(numbered[0], "").trim() };
  }
  const bare = /\b(highest|largest|biggest|smallest|lowest|bottom)\b/.exec(norm);
  if (bare) {
    const direction =
      bare[1] === "smallest" || bare[1] === "lowest" || bare[1] === "bottom" ? "lowest" : "highest";
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
    // "between A and B" is two filters, not one: an inclusive
    // range on both ends. It is checked before the single-operator
    // patterns, which would otherwise read "between" as noise.
    const between = /^(.+?)\s+between\s+(.+?)\s+and\s+(.+)$/i.exec(clause);
    if (between) {
      const hits = findColumns(between[1], columns);
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
      const lo = between[2].trim().replace(/^["']|["']$/g, "");
      const hi = between[3].trim().replace(/^["']|["']$/g, "");
      // A reversed range ("between 200 and 100") matches nothing
      // by construction — refuse it instead of answering "no rows".
      const loNum = Number(lo.replace(/,/g, ""));
      const hiNum = Number(hi.replace(/,/g, ""));
      const loDate = parseDate(lo);
      const hiDate = parseDate(hi);
      const reversed =
        (Number.isFinite(loNum) && Number.isFinite(hiNum) && loNum > hiNum) ||
        (loDate !== null &&
          hiDate !== null &&
          Date.UTC(loDate.year, loDate.month - 1, loDate.day) >
            Date.UTC(hiDate.year, hiDate.month - 1, hiDate.day));
      if (reversed) {
        return {
          filters,
          rest,
          error: `"between" needs the smaller value first — try e.g. "where ${hits[0].name} between ${hi} and ${lo}"`,
        };
      }
      filters.push({ column: hits[0].name, op: ">=", value: lo });
      filters.push({ column: hits[0].name, op: "<=", value: hi });
      rest = rest.slice(0, where.index).trim();
    } else {
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

/**
 * Try to read a share question ("what share of revenue is North",
 * "what percentage of total revenue comes from North", "what share
 * of rows are in North"). Returns null when the question shows no
 * share intent; otherwise a share query, or an abstention when the
 * subset or the column cannot be pinned down.
 *
 * The subset comes from the filters `extractFilters` already pulled
 * out ("where region is North", trailing "in North"), plus a trailing
 * "from <value>" / "is <value>" resolved against the sheet's known
 * categorical values ("revenue comes from North", "revenue is
 * North"). A value that belongs to several columns abstains —
 * guessing the column would share out the wrong subset.
 */
function tryParseShare(
  text: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\bshare\b|\bpercent(age)?\b|%/.test(norm)) return null;

  // A share compares totals. An explicit average/median/min/max
  // word asks for a share of a different statistic, which is not a
  // fraction of anything — refuse rather than answer the total.
  const op = detectAggregateOp(norm);
  if (op !== null && op !== "sum") {
    return {
      ok: false,
      reason:
        "share questions compare totals — try e.g. 'what share of total revenue is North'",
    };
  }

  // Strip the share wording and the filler around it, leaving the
  // column name and (for a value share) the subset's value word.
  const filler = new Set([
    "what",
    "share",
    "percentage",
    "percent",
    "of",
    "total",
    "sum",
    "combined",
    "comes",
    "come",
    "from",
    "is",
    "are",
    "the",
    "account",
    "accounts",
    "for",
    "in",
  ]);
  const cleaned = norm
    .replace(/%/g, " ")
    .split(" ")
    .filter((w) => !filler.has(w))
    .join(" ");

  const hits = findColumns(cleaned, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];

  // No column named: a row-count share ("what share of rows are in
  // North", "what percentage of employees are in Engineering") when
  // a filter already pins the subset down; otherwise there is
  // nothing to share out — or the named thing is not a column at all.
  if (distinct.length === 0) {
    if (filters.length > 0) {
      return { ok: true, query: { kind: "share", column: null, filters } };
    }
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to share out — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  const column = distinct[0];
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `sharing out needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }

  const allFilters = [...filters];
  // The subset's value, if one is still named in the question
  // ("revenue is North" — the column name is removed, "north" is
  // what's left). A "where …" / "in …" filter already extracted
  // means there is nothing left to resolve.
  const colName = normalize(column.name);
  const colNameSingular = colName.split(" ").map(singular).join(" ");
  let rest = cleaned;
  for (const name of [colName, colNameSingular]) {
    rest = rest.replace(name, " ").replace(/\s+/g, " ").trim();
  }
  if (rest !== "") {
    const owners = columns.filter((col, idx) => {
      if (col.type !== "text" && col.type !== "boolean") return false;
      return distinctValues(parsed, idx).has(rest);
    });
    if (owners.length === 0) {
      return {
        ok: false,
        reason: `could not find "${rest}" in any column — say which rows, e.g. "where ${columns.find((c) => c.type === "text")?.name ?? "region"} is ${rest}"`,
      };
    }
    if (owners.length > 1) {
      return {
        ok: false,
        reason: `"${rest}" appears in several columns (${owners.map((c) => c.name).join(", ")}) — say which one, e.g. "where ${owners[0].name} is ${rest}"`,
      };
    }
    // Keep the value's spelling as it appears in the sheet ("North",
    // not the lowercased "north" the parser matched on), so answers
    // read naturally.
    const ownerIdx = columns.indexOf(owners[0]);
    let rawValue = rest;
    for (const row of parsed.rows) {
      const cell = (row[ownerIdx] ?? "").trim();
      if (cell.toLowerCase() === rest) {
        rawValue = cell;
        break;
      }
    }
    allFilters.push({ column: owners[0].name, op: "=", value: rawValue });
  }
  if (allFilters.length === 0) {
    return {
      ok: false,
      reason:
        "a share needs a group to compare — say which rows, e.g. 'what share of revenue is North'",
    };
  }
  return { ok: true, query: { kind: "share", column: column.name, filters: allFilters } };
}

/**
 * Try to read a distinct-values question ("list unique regions",
 * "what are the distinct products", "show distinct departments").
 * Returns null when the question shows no distinct intent; otherwise
 * a distinct query, or an abstention when the column cannot be
 * pinned down. Blank cells are not values — they are never listed.
 */
function tryParseDistinct(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\bdistinct\b|\bunique\b/.test(norm)) return null;

  const filler = new Set([
    "what",
    "are",
    "the",
    "list",
    "show",
    "distinct",
    "unique",
    "values",
    "value",
    "of",
    "in",
  ]);
  const cleaned = norm
    .split(" ")
    .filter((w) => !filler.has(w))
    .join(" ");
  const hits = findColumns(cleaned, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
  if (distinct.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to list — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  return {
    ok: true,
    query: { kind: "distinct", column: distinct[0].name, filters, limit: 20 },
  };
}

/**
 * Try to read a mode question ("most common product", "what is the
 * mode of region", "most frequent department"). Returns null when
 * the question shows no mode intent; otherwise a mode query, or an
 * abstention when the column cannot be pinned down. A mode is one
 * column, ungrouped — "most common product by region" is a
 * per-group question the engine does not answer, so it abstains
 * rather than answering the whole-sheet mode.
 */
function tryParseMode(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\bmost common\b|\bmost frequent\b|\bmode\b/.test(norm)) return null;
  if (/\bby\b|\bper\b|\bgroup\b/.test(norm)) {
    return {
      ok: false,
      reason:
        "a mode question asks about one column — try e.g. 'most common product'",
    };
  }

  const filler = new Set([
    "what",
    "is",
    "the",
    "most",
    "common",
    "frequent",
    "mode",
    "of",
  ]);
  const cleaned = norm
    .split(" ")
    .filter((w) => !filler.has(w))
    .join(" ");
  const hits = findColumns(cleaned, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
  if (distinct.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column's mode to find — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  return {
    ok: true,
    query: { kind: "mode", column: distinct[0].name, filters },
  };
}

/**
 * Try to read a distinct-count question ("how many distinct
 * regions", "count distinct products", "number of different
 * departments"). Returns null when the question shows no
 * distinct-count intent; otherwise a distinctCount query, or an
 * abstention when the column cannot be pinned down. Blank cells are
 * not values — they are never counted. A bare "list distinct …"
 * (no counting word) is not a count question and is left for the
 * distinct-values parser.
 */
function tryParseDistinctCount(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\b(distinct|different)\b/.test(norm)) return null;
  if (!/\bhow many\b|\bcount\b|\bnumber of\b/.test(norm)) return null;
  if (/\bby\b|\bper\b|\bgroup\b/.test(norm)) {
    return {
      ok: false,
      reason:
        "a distinct count asks about one column — try e.g. 'how many distinct regions'",
    };
  }

  const filler = new Set([
    "how",
    "many",
    "count",
    "number",
    "of",
    "the",
    "distinct",
    "different",
    "values",
    "value",
  ]);
  const cleaned = norm
    .split(" ")
    .filter((w) => !filler.has(w))
    .join(" ");
  const hits = findColumns(cleaned, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
  if (distinct.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to count — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  return {
    ok: true,
    query: { kind: "distinctCount", column: distinct[0].name, filters },
  };
}

/**
 * Try to read a percentile question ("90th percentile of salary",
 * "p90 revenue", "what is the 25th percentile of age"). Returns null
 * when the question shows no percentile intent; otherwise a
 * percentile query, or an abstention when the percentile or the
 * column cannot be pinned down. A percentile is one column,
 * ungrouped — "90th percentile of salary by department" is a
 * per-group question the engine does not answer, so it abstains
 * rather than answering the whole-sheet percentile. Only 1–99 are
 * accepted: p = 0 and p = 100 are just the minimum and maximum,
 * which the aggregate words already answer.
 */
/**
 * Try to read an above/below-average question ("rows with revenue
 * above average", "which employees have salary below the median",
 * "above average revenue"). Returns null when the question shows no
 * above/below-average intent; otherwise an aboveBelow query, or an
 * abstention when the column cannot be pinned down or is not
 * numeric. The column may sit on either side of the marker: "above
 * average revenue" names it after, "rows with revenue above
 * average" names it before — the after-side wins when both name
 * one. A grouped question ("above average revenue by region")
 * names two columns and abstains rather than answering the
 * whole-sheet comparison.
 */
function tryParseAboveBelow(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  const marker = /\b(above|below|higher than|lower than)\s+(?:the\s+)?(average|median)\b/.exec(norm);
  if (!marker) return null;
  const direction: "above" | "below" =
    marker[1] === "above" || marker[1] === "higher than" ? "above" : "below";
  const baseline: "average" | "median" =
    marker[2] === "median" ? "median" : "average";
  const after = norm.slice(marker.index + marker[0].length).trim();
  const before = norm.slice(0, marker.index).trim();
  // The column is usually after the marker ("above average
  // revenue"); "rows with revenue above average" names it before.
  // Prefer the after-side, so "which products are above average
  // revenue" reads revenue, not the row noun "products".
  const filler = new Set(["what", "which", "is", "the", "of", "for", "rows", "row"]);
  const clean = (phrase: string): string =>
    phrase
      .split(" ")
      .filter((w) => !filler.has(w))
      .join(" ");
  const afterHits = [...new Map(findColumns(clean(after), columns).map((c) => [c.name, c])).values()];
  const beforeHits = [...new Map(findColumns(clean(before), columns).map((c) => [c.name, c])).values()];
  const hits = afterHits.length > 0 ? afterHits : beforeHits;
  if (hits.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to compare to its ${baseline} — matches ${hits.map((c) => c.name).join(", ")}`,
    };
  }
  const column = hits[0]!;
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `comparing to the ${baseline} needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  return {
    ok: true,
    query: { kind: "aboveBelow", column: column.name, direction, baseline, filters },
  };
}

/**
 * Try to read a missing-values question ("how many rows are missing
 * salary", "which columns have missing values", "show rows missing
 * revenue"). Returns null when the question shows no missing-values
 * intent; otherwise a missing query, or an abstention when the
 * column cannot be pinned down.
 *
 * Three shapes:
 * - one column, counted ("how many rows are missing salary") —
 *   "how many"/"count" wins over the row noun, so this counts
 *   instead of listing;
 * - one column, listed ("show rows missing revenue", "which rows
 *   are missing salary") — the rows themselves, first 10;
 * - no column ("which columns have missing values") — a report
 *   over every column. Listing with no column abstains: there is
 *   no one column to list. A grouped question ("missing salary
 *   by department") abstains, like mode and percentile — it is a
 *   per-group question the engine does not answer.
 */
function tryParseMissing(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\b(missing|blank|null|empty)\b/.test(norm)) return null;
  if (/\bby\b|\bper\b|\bgroup\b/.test(norm)) {
    return {
      ok: false,
      reason:
        "a missing-values question asks about one column — try e.g. 'how many rows are missing salary'",
    };
  }

  const filler = new Set([
    "what",
    "how",
    "many",
    "count",
    "rows",
    "row",
    "are",
    "is",
    "the",
    "of",
    "in",
    "with",
    "values",
    "value",
    "cells",
    "cell",
    "show",
    "list",
    "which",
    "columns",
    "column",
    "have",
    "has",
    "there",
    "any",
    "missing",
    "blank",
    "null",
    "empty",
    "for",
  ]);
  const cleaned = norm
    .split(" ")
    .filter((w) => !filler.has(w))
    .join(" ");
  const hits = findColumns(cleaned, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to check — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  const column = distinct[0] ?? null;
  if (column) {
    // Anything left after removing the column name is a word the
    // sheet does not explain — refuse rather than dropping it.
    const colName = normalize(column.name);
    const colNameSingular = colName.split(" ").map(singular).join(" ");
    let rest = cleaned;
    for (const name of [colName, colNameSingular]) {
      rest = rest.replace(name, " ").replace(/\s+/g, " ").trim();
    }
    if (rest !== "") {
      return {
        ok: false,
        reason: `could not understand "${rest}" in the question — try e.g. 'how many rows are missing ${column.name}'`,
      };
    }
  } else if (cleaned !== "") {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }

  // "how many"/"count" counts, even when the question also says
  // "rows" ("how many rows are missing salary"). Otherwise a
  // show/list/which-rows phrasing lists the rows.
  const wantsCount = /\bhow many\b|\bcount\b/.test(norm);
  const listRows =
    !wantsCount &&
    (/^\s*(show|list)\b/.test(norm) ||
      (/\bwhich\b/.test(norm) && /\brows?\b/.test(norm) && column !== null));
  if (listRows && column === null) {
    return {
      ok: false,
      reason:
        "listing missing rows needs one column — try e.g. 'show rows missing salary'",
    };
  }
  return {
    ok: true,
    query: { kind: "missing", column: column?.name ?? null, filters, listRows },
  };
}

function tryParsePercentile(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  const ordinal = /(\d{1,3})(?:st|nd|rd|th)?\s*percentile\b/.exec(norm);
  const short = /\bp(\d{1,3})\b/.exec(norm);
  const match = ordinal ?? short;
  if (!match) return null;
  const p = Number(match[1]);
  if (p < 1 || p > 99) {
    return {
      ok: false,
      reason: `a percentile must be between 1 and 99 — "${p}" is outside that range (try e.g. '90th percentile of salary')`,
    };
  }
  if (/\bby\b|\bper\b|\bgroup\b/.test(norm)) {
    return {
      ok: false,
      reason:
        "a percentile question asks about one column — try e.g. '90th percentile of salary'",
    };
  }

  const filler = new Set([
    "what",
    "is",
    "the",
    "of",
    "percentile",
  ]);
  const cleaned = norm
    .replace(/\bp\d{1,3}\b/g, " ")
    .replace(/\b\d{1,3}(?:st|nd|rd|th)?\s*percentile\b/g, " ")
    .split(" ")
    .filter((w) => !filler.has(w))
    .join(" ");
  const hits = findColumns(cleaned, columns);
  const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
  if (distinct.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column's percentile to find — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  const column = distinct[0];
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `a percentile needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  return {
    ok: true,
    query: { kind: "percentile", column: column.name, p, filters },
  };
}

/**
 * Try to read a trend question ("revenue trend by month", "average
 * salary trend by year", "is revenue trending up"). Returns null
 * when the question shows no trend intent; otherwise a trend query,
 * or an abstention when the period, the date column or the target
 * column cannot be pinned down. A trend is one column over one
 * period — "revenue trend by month and region" is two dimensions
 * at once and is refused by the combined-period guard in
 * `parseQuestion` before this runs.
 */
function tryParseTrend(
  text: string,
  columns: ColumnInfo[],
  bucket: TimeBucket | null,
  filters: Filter[],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\btrend\w*\b/.test(norm)) return null;
  if (!bucket) {
    return {
      ok: false,
      reason: "a trend needs a period — try e.g. 'revenue trend by month'",
    };
  }
  const dates = columns.filter((c) => c.type === "date");
  if (dates.length === 0) {
    return {
      ok: false,
      reason: `trending over time needs a date column — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (dates.length > 1) {
    return {
      ok: false,
      reason: `could not tell which date column to trend by — matches ${dates.map((c) => c.name).join(", ")}`,
    };
  }
  const dateColumn = dates[0];
  const op = detectAggregateOp(norm) ?? "sum";

  // Strip the trend wording, the period word and filler, leaving
  // the column name ("average salary trend by year" -> "average
  // salary"). Bucket aliases ("monthly") are stripped too.
  const filler = new Set([
    "trend",
    "trending",
    "trends",
    "trended",
    "is",
    "the",
    "of",
    "by",
    "per",
    "over",
    "time",
    "up",
    "down",
    "going",
    "goes",
    "went",
    "what",
    "how",
    "does",
    "do",
    "a",
    "an",
  ]);
  const periodWords = new Set(Object.keys(BUCKET_WORDS));
  const cleaned = norm
    .split(" ")
    .filter(
      (w) =>
        !filler.has(w) &&
        !periodWords.has(w) &&
        !periodWords.has(w.endsWith("s") ? w.slice(0, -1) : w),
    )
    .join(" ");
  const candidates = findColumns(cleaned, columns).filter(
    (c) => c.name !== dateColumn.name,
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
      reason: `could not tell which column to trend — matches ${candidates.map((c) => c.name).join(", ")}`,
    };
  }
  const column = candidates[0];
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `a trend needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  return {
    ok: true,
    query: {
      kind: "trend",
      column: column.name,
      op,
      dateColumn: dateColumn.name,
      bucket,
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

  // Sorted rows: pull the sort clause out first (see extractSort) —
  // the filter extractor would otherwise swallow it into a "where"
  // value, and the group-by extractor would read it as a grouping.
  const sort = extractSort(question, columns);
  if (sort.error) return { ok: false, reason: sort.error };

  const extracted = extractFilters(sort.rest, parsed);
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
  if (bucket) {
    // "total revenue by month and region" — the bucket extractor
    // removed "by month" and left "and region" behind; answering
    // the monthly grouping would silently drop the second group.
    // Only a column named right after the period clause counts:
    // "correlation between revenue and units by month" ends in
    // "and units" too, but that "and" belongs to the correlation.
    const periodWords = Object.keys(BUCKET_WORDS).join("|");
    const combined = new RegExp(
      `\\b(?:by|per)\\s+(?:${periodWords})s?\\s+and\\s+([a-z][a-z ]*?)(?:\\s+by\\b|\\s*$)`,
    ).exec(normalize(extracted.rest));
    if (combined) {
      const extra = findColumns(combined[1], columns);
      if (extra.length > 0) {
        return {
          ok: false,
          reason: `group by one dimension at a time — "by ${bucket}" and "by ${extra[0]!.name}" can't combine; try one or the other`,
        };
      }
    }
  }

  // Trend: a column's aggregate fitted over a time period
  // ("revenue trend by month"). Once the question shows trend intent
  // it is parsed here or abstained — falling through would answer
  // the plain monthly grouping instead of the trend asked for.
  const trend = tryParseTrend(timeBucket.rest, columns, bucket, filters);
  if (trend) return trend;

  // Share: a filtered subset's total as a share of the whole sheet.
  // Once the question shows share intent it is parsed here or
  // abstained — falling through would answer the plain total instead
  // of the share asked for.
  const share = tryParseShare(timeBucket.rest, columns, parsed, filters);
  if (share) {
    if (bucket) {
      return {
        ok: false,
        reason: "a share can't be grouped by a time period — ask about the whole sheet, e.g. 'what share of revenue is North'",
      };
    }
    return share;
  }

  // Mode: the most frequent value of one column. Checked before
  // the generic distinct-values parser, which would otherwise read
  // "most common" as nothing and fall through to the rows fallback.
  const mode = tryParseMode(timeBucket.rest, columns, filters);
  if (mode) {
    if (bucket) {
      return {
        ok: false,
        reason: "a mode can't be grouped by a time period — ask about the whole sheet, e.g. 'most common product'",
      };
    }
    return mode;
  }

  // Distinct count: how many different values one column has.
  // Checked before the distinct-values listing, which would
  // otherwise answer "how many distinct regions" with the list.
  const distinctCount = tryParseDistinctCount(timeBucket.rest, columns, filters);
  if (distinctCount) {
    if (bucket) {
      return {
        ok: false,
        reason: "a distinct count can't be grouped by a time period — ask about the whole sheet, e.g. 'how many distinct regions'",
      };
    }
    return distinctCount;
  }

  // Percentile: one column's p-th percentile ("90th percentile of
  // salary", "p90 revenue"). Checked before the distinct-values
  // listing and the generic aggregate fallback, which would
  // otherwise read "90th percentile" as nothing and abstain with a
  // less useful reason.
  const percentile = tryParsePercentile(timeBucket.rest, columns, filters);
  if (percentile) {
    if (bucket) {
      return {
        ok: false,
        reason: "a percentile can't be grouped by a time period — ask about the whole sheet, e.g. '90th percentile of salary'",
      };
    }
    return percentile;
  }

  // Above/below average: rows on one side of a column's own mean or
  // median ("rows with revenue above average"). Checked before the
  // generic aggregate fallback, which would otherwise read "average"
  // as a plain mean and answer the average itself.
  const aboveBelow = tryParseAboveBelow(timeBucket.rest, columns, filters);
  if (aboveBelow) {
    if (bucket) {
      return {
        ok: false,
        reason: "comparing to the average can't be grouped by a time period — ask about the whole sheet, e.g. 'rows with revenue above average'",
      };
    }
    return aboveBelow;
  }

  // Missing values: a count per column, a whole-sheet report, or
  // the rows themselves ("show rows missing revenue"). Checked
  // before the distinct-values listing and the generic aggregate
  // fallback, which would otherwise read "missing" as nothing and
  // answer a count of rows or abstain with a less useful reason.
  const missing = tryParseMissing(timeBucket.rest, columns, filters);
  if (missing) {
    if (bucket) {
      return {
        ok: false,
        reason:
          "missing values can't be grouped by a time period — ask about the whole sheet, e.g. 'how many rows are missing salary'",
      };
    }
    return missing;
  }

  // Distinct values: every distinct value of one column, with row
  // counts. Checked before the generic "list/show rows" fallback
  // below, which would otherwise answer with rows instead.
  const distinct = tryParseDistinct(timeBucket.rest, columns, filters);
  if (distinct) {
    if (bucket) {
      return {
        ok: false,
        reason: "distinct values can't be grouped by a time period — ask about the whole sheet, e.g. 'list unique regions'",
      };
    }
    return distinct;
  }

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
      ? matchColumnsInOrder(groupPhrase, columns)
          .map((s) => s.col)
          .filter((c) => c.name !== rankColumn.name)
      : [];
    if (groupHits.length > 3) {
      return {
        ok: false,
        reason:
          "rank at most three columns at a time — e.g. 'top 3 region and product by revenue'",
      };
    }
    // A bare period word ranks the periods ("top 3 months by
    // revenue") — the grouped column is the sheet's date column.
    // A column actually named "months" still wins over the period.
    let topBucket: TimeBucket | undefined;
    let topGroupBy: string[] | undefined =
      groupHits.length > 0 ? groupHits.map((c) => c.name) : undefined;
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
        topGroupBy = [resolved.column!.name];
      }
    }
    // A time bucket with a top-N question ranks the periods
    // ("top 3 products by revenue by month" is two-dimensional and
    // abstains — the grouped column must be a date column).
    if (bucket) {
      if (groupHits.length > 1) {
        return {
          ok: false,
          reason: `group by one dimension at a time — "by ${groupHits.map((c) => c.name).join(" and ")}" can't be combined with by ${bucket}; try one or the other`,
        };
      }
      const resolved = resolveBucketColumn(bucket, groupHits[0] ?? null, columns);
      if (resolved.error) return { ok: false, reason: resolved.error };
      topBucket = bucket;
      topGroupBy = [resolved.column!.name];
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

  const { groupBy, rest, error } = extractGroupBy(timeBucket.rest, columns);
  if (error) return { ok: false, reason: error };
  // A time bucket needs a date column to group: the explicit
  // group-by column when one was named, else the sheet's only date
  // column. A bucket plus a second group column is two dimensions
  // at once — out of scope, and answering only the bucket would
  // silently drop the other group.
  let resolvedGroupBy = groupBy;
  if (bucket) {
    if (groupBy.length > 1) {
      return {
        ok: false,
        reason: `group by one dimension at a time — "by ${groupBy.map((c) => c.name).join(" and ")}" can't be combined with by ${bucket}; try one or the other`,
      };
    }
    const resolved = resolveBucketColumn(bucket, groupBy[0] ?? null, columns);
    if (resolved.error) return { ok: false, reason: resolved.error };
    resolvedGroupBy = resolved.column ? [resolved.column] : [];
  }
  const text = rest === "" ? timeBucket.rest : rest;

  // Count questions need no target column. A sort phrase does not
  // belong on a count — "how many rows sorted by revenue" refuses
  // instead of silently dropping the sort.
  if (isCountQuestion(text) && resolvedGroupBy.length === 0) {
    if (sort.sort) {
      return {
        ok: false,
        reason:
          "sorting applies to row listings — try e.g. 'show rows sorted by revenue descending'",
      };
    }
    return { ok: true, query: { kind: "count", filters } };
  }
  if (isCountQuestion(text) && resolvedGroupBy.length > 0) {
    return {
      ok: true,
      query: {
        kind: "group",
        groupBy: resolvedGroupBy.map((c) => c.name),
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
  // A sort phrase also means a row listing ("rows sorted by revenue"),
  // even with no show/list verb and no filter.
  const normText = normalize(text);
  if (
    normText.startsWith("show") ||
    normText.startsWith("list") ||
    (sort.sort !== null && !op) ||
    (filters.length > 0 && !op)
  ) {
    return {
      ok: true,
      query: { kind: "rows", filters, limit: 10, sort: sort.sort ?? undefined },
    };
  }
  // A sort phrase only makes sense on a row listing — "total revenue
  // sorted by region" refuses instead of answering the plain total
  // and dropping the sort.
  if (sort.sort) {
    return {
      ok: false,
      reason:
        "sorting applies to row listings — try e.g. 'show rows sorted by revenue descending'",
    };
  }
  if (!op) {
    return {
      ok: false,
      reason:
        "I can answer totals, averages, medians, minimums, maximums and counts — " +
        "try e.g. 'total revenue' or 'average salary by department'",
    };
  }

  // The target column is the one named in the question, excluding
  // the group-by columns (already consumed).
  const candidates = findColumns(text, columns).filter(
    (c) => !resolvedGroupBy.some((g) => g.name === c.name),
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

  if (resolvedGroupBy.length > 0) {
    return {
      ok: true,
      query: {
        kind: "group",
        groupBy: resolvedGroupBy.map((c) => c.name),
        column: column.name,
        op,
        filters,
        bucket: bucket ?? undefined,
      },
    };
  }
  return { ok: true, query: { kind: "aggregate", column: column.name, op, filters } };
}
