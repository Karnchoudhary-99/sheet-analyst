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
 * - compound filters: "total revenue where region is North and
 *   product is Widget A", "how many rows where revenue > 100 and
 *   units < 10" (every condition must hold; a between-range keeps
 *   its own "and" — "where revenue between 100 and 200 and region
 *   is North" — and an "and" inside a value is left alone:
 *   "where product is Salt and Pepper" still reads as one filter)
 * - or filters: "total revenue where region is North or South",
 *   "how many rows where revenue > 100 or revenue < 10" (at least
 *   one branch must hold; AND binds tighter, so "a and b or c" is
 *   (a and b) or c; a bare value inherits the column of the most
 *   recent "=" filter — "region is North or South" reads as region
 *   is North or region is South; quote a value that contains "or",
 *   e.g. product is "Salt or Pepper")
 * - exclusion: "total revenue excluding North", "total revenue
 *   except Widget A" (the complement of "in" — a "!=" filter on
 *   the owning column; several values exclude several; an unknown
 *   or multi-column value abstains; "excluding" inside a where
 *   clause is refused with a pointer to "is not")
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
 * - distribution: "distribution of salary", "histogram of revenue"
 *   (values binned into an equal-width histogram, at most 10 bins;
 *   a numeric column only — a text column abstains)
 * - mode: "most common product", "what is the mode of region" (the
 *   value that appears most often; ties break alphabetically)
 * - distinct count: "how many distinct regions", "count distinct
 *   products" (how many different values a column has, blanks excluded)
 * - percentile: "90th percentile of salary", "p90 revenue" (linear
 *   interpolation, the same method as the quartiles in describe)
 * - rank: "second highest salary", "3rd lowest revenue" (the nth
 *   distinct value from the top or the bottom of one numeric column;
 *   ties share the rank, so the answer also says how many rows hold
 *   that value)
 * - group rank: "second highest total revenue by region", "which
 *   region has the second highest total revenue" (the nth distinct
 *   per-group aggregate from the top or the bottom; a bare aggregate
 *   reads as the total, an explicit "average"/"median"/"minimum"/
 *   "maximum" overrides it; one group column at a time)
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
 * - outliers: "how many outliers in revenue", "which columns have
 *   outliers" (a count per column, or a whole-sheet report over
 *   every numeric column), "show outliers in revenue" (the rows
 *   themselves, first 10)
 * - duplicates: "how many duplicate rows", "which columns have
 *   duplicates" (a count per column, or a whole-sheet report over
 *   every column, plus the exact duplicate rows), "show duplicate
 *   rows" / "show duplicates in product" (the duplicate rows
 *   themselves, first 10)
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
  /**
   * When set, the filter compares the row's `column` cell against
   * the same row's cell in this column instead of against `value`
   * ("where revenue is greater than units"): `value` is then "".
   * Only ordered comparisons (>, >=, <, <=) between two numeric or
   * two date columns ever set it — a literal that happens to spell
   * a column name stays a literal, and text columns abstain.
   */
  compareColumn?: string;
}

/**
 * `orGroups` (on every query kind) holds the OR side of a where
 * clause: each group is an AND of its filters, and at least one
 * group must hold fully — "where region is North or South" is two
 * one-filter groups. Absent (or empty) means no OR constraint; the
 * plain `filters` are always AND. Only a top-level "or" in a where
 * clause ever sets it.
 */
export type Query =
  | { kind: "aggregate"; column: string; op: Exclude<AggregateOp, "count">; filters: Filter[]; orGroups?: Filter[][] }
  | { kind: "count"; filters: Filter[]; orGroups?: Filter[][] }
  | {
      kind: "group";
      /** One or more columns, in the order named in the question. */
      groupBy: string[];
      column: string | null;
      op: AggregateOp;
      filters: Filter[];
      orGroups?: Filter[][];
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
      orGroups?: Filter[][];
      bucket?: TimeBucket;
    }
  | { kind: "rows"; filters: Filter[]; orGroups?: Filter[][]; limit: number; sort?: SortSpec }
  | { kind: "correlation"; columnA: string; columnB: string; filters: Filter[]; orGroups?: Filter[][] }
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
      orGroups?: Filter[][];
    }
  | {
      kind: "headtohead";
      /** The column the aggregate is read from, or null for a row-count comparison. */
      column: string | null;
      op: AggregateOp;
      /** The categorical column both sides belong to ("region" in "North vs South"). */
      groupColumn: string;
      /** Each side's value, spelled as it appears in the sheet. */
      sideA: string;
      sideB: string;
      filters: Filter[];
      orGroups?: Filter[][];
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
      orGroups?: Filter[][];
    }
  | {
      kind: "distinct";
      /** The column whose distinct values are listed. */
      column: string;
      filters: Filter[];
      orGroups?: Filter[][];
      /** Most values shown (default 20); the result reports the total. */
      limit: number;
    }
  | {
      kind: "distribution";
      /** The numeric column whose values are binned. */
      column: string;
      filters: Filter[];
      orGroups?: Filter[][];
    }
  | {
      kind: "mode";
      /** The column whose most frequent value is asked for. */
      column: string;
      filters: Filter[];
      orGroups?: Filter[][];
    }
  | {
      kind: "distinctCount";
      /** The column whose number of distinct values is asked for. */
      column: string;
      filters: Filter[];
      orGroups?: Filter[][];
    }
  | {
      kind: "percentile";
      /** The column the percentile is read from. */
      column: string;
      /** 1–99: "90th percentile" is p = 90. */
      p: number;
      filters: Filter[];
      orGroups?: Filter[][];
    }
  | {
      kind: "rank";
      /** The column the rank is read from. */
      column: string;
      /** 1-based: "second highest" is n = 2. */
      n: number;
      /** Which end of the ranking the rank is counted from. */
      direction: "highest" | "lowest";
      /**
       * When set, the rank is over per-group aggregates instead of
       * rows: "second highest total revenue by region" ranks each
       * region's total. `op` is how each group's value is computed
       * (default sum — the groupextreme convention).
       */
      groupBy?: string;
      op?: Exclude<AggregateOp, "count">;
      filters: Filter[];
      orGroups?: Filter[][];
    }
  | {
      kind: "groupextreme";
      /** The column whose values are compared ("which region ..."). */
      groupBy: string;
      /** The column the aggregate is read from. */
      column: string;
      /**
       * How each group's value is computed. A bare "highest revenue"
       * means the highest total — a group is a set of rows, so its
       * total is the natural reading; an explicit "average"/"median"/
       * "minimum"/"maximum" overrides it.
       */
      op: Exclude<AggregateOp, "count">;
      /** Which end of the per-group ranking wins. */
      direction: "highest" | "lowest";
      filters: Filter[];
      orGroups?: Filter[][];
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
      orGroups?: Filter[][];
    }
  | {
      kind: "cumulative";
      /** The column the running total is read from. */
      column: string;
      /** The date column the periods are read from. */
      dateColumn: string;
      /** The period the running total is bucketed into. */
      bucket: TimeBucket;
      filters: Filter[];
      orGroups?: Filter[][];
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
      orGroups?: Filter[][];
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
      orGroups?: Filter[][];
      /**
       * True for "show rows missing <column>": list the rows
       * themselves instead of counting them.
       */
      listRows: boolean;
    }
  | {
      kind: "outliers";
      /**
       * The column to check, or null for a whole-sheet report over
       * every numeric column ("which columns have outliers").
       * An outlier is a value outside the Tukey IQR fence — the
       * same fence the data-quality profile reports.
       */
      column: string | null;
      filters: Filter[];
      orGroups?: Filter[][];
      /**
       * True for "show outliers in <column>": list the rows
       * themselves instead of counting them.
       */
      listRows: boolean;
    }
  | {
      kind: "duplicates";
      /**
       * The column to check, or null for a whole-sheet report over
       * every column ("which columns have duplicates"). A duplicate
       * is a value that appears more than once — blanks are not
       * values, so two blank cells never count as a duplicate. The
       * report also counts exact duplicate rows: a full row
       * identical to an earlier one, the same definition the
       * data-quality profile uses.
       */
      column: string | null;
      filters: Filter[];
      orGroups?: Filter[][];
      /**
       * True for "show duplicate rows" / "show duplicates in
       * <column>": list the duplicate rows themselves instead of
       * counting them.
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
  // "-ies" pluralises a trailing "y" ("salaries" -> "salary"), so
  // undo that first; otherwise a plain trailing "s" ("revenues" ->
  // "revenue"). "series" would singularise to "sery", but that
  // spelling is only ever used as a fallback — the raw name still
  // matches first in findColumns, so a "series" column is safe.
  if (word.endsWith("ies") && word.length > 3) return word.slice(0, -3) + "y";
  return word.endsWith("s") && word.length > 1 ? word.slice(0, -1) : word;
}

/**
 * The plural of a word: a trailing consonant + "y" becomes "-ies"
 * ("salary" -> "salaries"), otherwise a plain "s" ("revenue" ->
 * "revenues"). A word already ending in "s" ("units") is its own
 * plural here — its singular is handled by singular().
 */
function plural(word: string): string {
  if (word.endsWith("s")) return word;
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  return `${word}s`;
}

/**
 * Remove a column name from a cleaned question, leaving whatever
 * the sheet does not explain. The plural form is removed first:
 * "missing salaries" names the salary column, and removing
 * "salary" from "salaries" would otherwise leave a stray "s"
 * behind. Multi-word names pluralise their last word ("start
 * dates"). The singular form is tried too, so "missing unit"
 * still names the "units" column.
 */
function stripColumnName(cleaned: string, column: ColumnInfo): string {
  const colName = normalize(column.name);
  const words = colName.split(" ");
  const last = words[words.length - 1];
  const colNamePlural = [...words.slice(0, -1), plural(last)].join(" ");
  const colNameSingular = words.map(singular).join(" ");
  const singularLast = singular(last);
  const colNameSingularPlural = [...words.slice(0, -1), plural(singularLast)].join(" ");
  let rest = cleaned;
  for (const name of [colNamePlural, colNameSingularPlural, colName, colNameSingular]) {
    rest = rest.replace(name, " ").replace(/\s+/g, " ").trim();
  }
  return rest;
}

/**
 * Edit distance between two words, for "did you mean" hints on
 * abstentions ("revnue" is one edit from "revenue"). Classic
 * dynamic programming with one row of state.
 */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * Closest column names to the words of a phrase the parser could
 * not match. A word suggests a column when it is within edit
 * distance 2 of the column name (or one of its words), or a prefix
 * of it ("rev" for "revenue"). Returns at most `max` distinct
 * names, best first. Short words (under 3 letters) never suggest —
 * "in" is not a typo of anything.
 */
function suggestColumns(phrase: string, columns: ColumnInfo[], max = 2): string[] {
  const words = normalize(phrase)
    .split(" ")
    .filter((w) => w !== "" && w.length >= 3);
  const scored: { name: string; dist: number }[] = [];
  for (const col of columns) {
    const name = normalize(col.name);
    const nameWords = name.split(" ");
    let best = Infinity;
    for (const w of words) {
      for (const nw of [name, ...nameWords]) {
        if (nw.startsWith(w) || w.startsWith(nw)) {
          best = Math.min(best, 0);
        } else {
          best = Math.min(best, levenshtein(w, nw));
        }
      }
    }
    if (best <= 2) scored.push({ name: col.name, dist: best });
  }
  scored.sort((a, b) => a.dist - b.dist);
  return [...new Set(scored.map((s) => s.name))].slice(0, max);
}

/** " — did you mean \"revenue\"?" (or "" when nothing is close). */
function didYouMean(phrase: string, columns: ColumnInfo[]): string {
  const suggestions = suggestColumns(phrase, columns);
  if (suggestions.length === 0) return "";
  if (suggestions.length === 1) return ` — did you mean "${suggestions[0]}"?`;
  return ` — did you mean "${suggestions[0]}" or "${suggestions[1]}"?`;
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

/**
 * The column a whole phrase names, if it names exactly one: the
 * normalized phrase (or its singular form) must equal the column's
 * normalized name (or its singular form). Stricter than
 * findColumns, which is substring-based — "units" must not resolve
 * to a "units sold" column, and "unit" may still match "units".
 * Used only to tell a column reference on the right-hand side of a
 * comparison ("revenue > units") apart from a literal value that
 * happens to spell a column name ("region is revenue").
 */
function resolveExactColumn(
  value: string,
  columns: ColumnInfo[],
): ColumnInfo | null {
  const text = normalize(value);
  if (text === "") return null;
  const textSingular = text.split(" ").map(singular).join(" ");
  const hits = columns.filter((col) => {
    const name = normalize(col.name);
    const nameSingular = name.split(" ").map(singular).join(" ");
    return (
      text === name ||
      text === nameSingular ||
      textSingular === name ||
      textSingular === nameSingular
    );
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** Numeric (integer/number), date, or anything else — the only two
 * pairings a cross-column comparison is allowed to make. */
function columnKind(type: ColumnInfo["type"]): "number" | "date" | "other" {
  if (type === "integer" || type === "number") return "number";
  if (type === "date") return "date";
  return "other";
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
    if (kept.length === 0) {
      // A "by <word>" clause that names no column is a typo'd
      // group-by, not something to silently drop — "total revenue
      // by regoin" must not answer the plain total. (Time buckets
      // were already stripped by extractTimeBucket, and top-N
      // questions return before this runs, so a leftover "by" can
      // only be a group-by.)
      if (tail === "") {
        return {
          groupBy: [],
          rest: text,
          error: `nothing follows "${marker}" — name a column to group by, e.g. "by region"`,
        };
      }
      return {
        groupBy: [],
        rest: text,
        error: `could not find a column to group by in "${marker} ${tail}" — columns are: ${columns.map((c) => c.name).join(", ")}${didYouMean(tail, columns)}`,
      };
    }
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
        error: `could not find a column named "${stray.join(" ")}" — columns are: ${columns.map((c) => c.name).join(", ")}${didYouMean(stray.join(" "), columns)}`,
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
  /** OR-groups from the where clause (see the Query doc). */
  orGroups: Filter[][];
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
 * the column would answer a different question. A trailing list
 * ("in North and South", "in North or South") resolves to OR groups
 * instead of being silently dropped, and a single unknown trailing
 * value ("in 2024") abstains — answering the whole sheet would
 * answer a different question than the one asked.
 */
/**
 * The column phrase of a where condition must be the column name
 * (plus harmless filler: "the", "a", "an", the "is" of "is greater
 * than", an aggregate word like "total"). Anything else is a word
 * the question meant as something else, and silently dropping it
 * would answer a different question — "South and product is
 * Widget A" must not parse as product is Widget A with "South"
 * discarded. Returns the stray words, or null when the phrase is
 * clean.
 */
function checkColumnPhrase(phrase: string, column: ColumnInfo): string | null {
  const allowed = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    ...AGGREGATE_WORDS.flatMap((a) => a.words),
  ]);
  // Match the column name word by word (singular/plural tolerant),
  // so "start dates" still names "start date" — but never
  // singularise the filler words themselves ("is" would become "i").
  const words = normalize(phrase)
    .split(" ")
    .filter((w) => w !== "");
  const remaining = [...words];
  for (const nw of normalize(column.name)
    .split(" ")
    .filter((w) => w !== "")) {
    const idx = remaining.findIndex((w) => w === nw || singular(w) === singular(nw));
    if (idx >= 0) remaining.splice(idx, 1);
  }
  const stray = remaining.filter((w) => !allowed.has(w));
  return stray.length === 0 ? null : stray.join(" ");
}

/**
 * Parse one `where` condition — "region is North", "revenue > 100",
 * "revenue between 100 and 200" — into its filters. A condition that
 * matches no operator pattern at all ("Pepper", a bare word) is a
 * *soft* failure: it is not shaped like a condition, so the caller
 * may fall back to treating a longer clause as one condition (a value
 * containing "and", e.g. "product is Salt and Pepper"). Every other
 * failure — an unknown column, an ambiguous column, a reversed range —
 * is hard: the condition was understood well enough to know it is
 * wrong, and falling back would only hide that.
 */
function parseWhereCondition(
  condition: string,
  columns: ColumnInfo[],
): { filters: Filter[] } | { error: string; soft: boolean } {
  // "between A and B" is two filters, not one: an inclusive
  // range on both ends. It is checked before the single-operator
  // patterns, which would otherwise read "between" as noise.
  const between = /^(.+?)\s+between\s+(.+?)\s+and\s+(.+)$/i.exec(condition);
  if (between) {
    const hits = findColumns(between[1], columns);
    if (hits.length === 0) {
      return {
        error: `could not find a column in "where ${condition}" — columns are: ${columns.map((c) => c.name).join(", ")}${didYouMean(between[1], columns)}`,
        soft: false,
      };
    }
    if (hits.length > 1) {
      return {
        error: `could not tell which column "where ${condition}" means — matches ${hits.map((c) => c.name).join(", ")}`,
        soft: false,
      };
    }
    const strayBetween = checkColumnPhrase(between[1], hits[0]);
    if (strayBetween !== null) {
      return {
        error: `could not understand "where ${condition}" — "${strayBetween}" is not part of a column name`,
        soft: false,
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
        error: `"between" needs the smaller value first — try e.g. "where ${hits[0].name} between ${hi} and ${lo}"`,
        soft: false,
      };
    }
    return {
      filters: [
        { column: hits[0].name, op: ">=", value: lo },
        { column: hits[0].name, op: "<=", value: hi },
      ],
    };
  }

  const opPatterns: { op: FilterOp; re: RegExp }[] = [
    { op: "!=", re: /^(.*?)\s+(?:is not|isn't|!=|not)\s+(.+)$/i },
    { op: ">=", re: /^(.*?)\s+(?:at least|>=)\s+(.+)$/i },
    { op: "<=", re: /^(.*?)\s+(?:at most|<=)\s+(.+)$/i },
    { op: ">", re: /^(.*?)\s+(?:greater than|more than|after|since|>)\s+(.+)$/i },
    { op: "<", re: /^(.*?)\s+(?:less than|fewer than|before|until|<)\s+(.+)$/i },
    { op: "contains", re: /^(.*?)\s+contains\s+(.+)$/i },
    { op: "=", re: /^(.*?)\s+(?:is|=|==|equals?)\s+(.+)$/i },
  ];
  for (const { op, re } of opPatterns) {
    const m = re.exec(condition);
    if (!m) continue;
    const hits = findColumns(m[1], columns);
    if (hits.length === 0) {
      return {
        error: `could not find a column in "where ${condition}" — columns are: ${columns.map((c) => c.name).join(", ")}${didYouMean(m[1], columns)}`,
        soft: false,
      };
    }
    if (hits.length > 1) {
      return {
        error: `could not tell which column "where ${condition}" means — matches ${hits.map((c) => c.name).join(", ")}`,
        soft: false,
      };
    }
    const stray = checkColumnPhrase(m[1], hits[0]);
    if (stray !== null) {
      return {
        error: `could not understand "where ${condition}" — "${stray}" is not part of a column name`,
        soft: false,
      };
    }
    const rawValue = m[2].trim();
    const quoted = /^["'].*["']$/.test(rawValue);
    const value = rawValue.replace(/^["']|["']$/g, "");
    // A cross-column comparison: "where revenue is greater than
    // units" compares two columns in the same row, not a column
    // against a literal. Only ordered comparisons take this path,
    // and only when the right-hand side names exactly one other
    // column of a comparable kind — "=" and "!=" keep literal
    // semantics ("where region is revenue" means a region literally
    // called revenue), and a quoted right-hand side is always a
    // literal, never a column reference. Text and boolean columns
    // abstain: an alphabetical "greater than" would be a surprise,
    // not an answer.
    if (!quoted && (op === ">" || op === ">=" || op === "<" || op === "<=")) {
      const rhs = resolveExactColumn(value, columns);
      if (rhs !== null) {
        if (rhs.name === hits[0].name) {
          return {
            error: `cannot compare "${hits[0].name}" with itself — "where ${condition}" needs two different columns`,
            soft: false,
          };
        }
        const leftKind = columnKind(hits[0].type);
        const rightKind = columnKind(rhs.type);
        if (leftKind !== rightKind || leftKind === "other") {
          return {
            error:
              `cannot compare "${hits[0].name}" (${hits[0].type}) with "${rhs.name}" (${rhs.type}) — ` +
              `a cross-column comparison needs two numbers or two dates`,
            soft: false,
          };
        }
        return {
          filters: [
            { column: hits[0].name, op, value: "", compareColumn: rhs.name },
          ],
        };
      }
    }
    return { filters: [{ column: hits[0].name, op, value }] };
  }
  return {
    error: `could not understand the filter in "where ${condition}" — try e.g. "where region is North" or "where revenue > 100"`,
    soft: true,
  };
}

/**
 * Split a `where` clause on top-level " and " — an "and" outside
 * quotes, surrounded by whitespace — so "region is North and product
 * is Widget A" becomes two conditions. An "and" inside a quoted
 * value ("product is \"Salt and Pepper\"") is not a separator, and
 * neither is one glued to a word ("Android" stays whole).
 */
function splitTopLevelAnd(clause: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < clause.length) {
    const ch = clause[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    const sep = /^\s+and\s+/i.exec(clause.slice(i));
    if (sep) {
      parts.push(clause.slice(start, i).trim());
      i += sep[0].length;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(clause.slice(start).trim());
  return parts;
}

/**
 * A naive " and " split breaks a between-range: "revenue between 100
 * and 200 and region is North" splits into ["revenue between 100",
 * "200", "region is North"]. A part that ends with "between <value>"
 * swallowed the range's own "and", so merge it back with the next
 * part before the pieces are parsed as conditions.
 */
function mergeBetweenFragments(parts: string[]): string[] {
  const merged: string[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && /\bbetween\s+\S+\s*$/i.test(last)) {
      merged[merged.length - 1] = `${last} and ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

/**
 * Split a `where` clause on top-level " or " — an "or" outside
 * quotes, surrounded by whitespace — so "region is North or South"
 * becomes two branches. An "or" inside a quoted value ("product is
 * \"Salt or Pepper\"") is not a separator, and neither is one glued
 * to a word ("Color" stays whole).
 */
function splitTopLevelOr(clause: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < clause.length) {
    const ch = clause[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    const sep = /^\s+or\s+/i.exec(clause.slice(i));
    if (sep) {
      parts.push(clause.slice(start, i).trim());
      i += sep[0].length;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(clause.slice(start).trim());
  return parts;
}

/**
 * Parse one branch of an OR clause — "region is North", "region is
 * North and revenue > 100", or a bare value ("South") that inherits
 * the column and operator of the most recent single "=" filter.
 * `lastEquals` is that filter from the branches before this one
 * (null when there is none, or when the most recent branch was not
 * a single "=" filter). Returns the branch's filters plus the
 * updated most-recent "=" filter, or an error.
 *
 * A branch with several "and" parts is tried three ways, in order:
 * every part as a condition; the whole branch as one condition (a
 * value containing "and", e.g. "product is Salt and Pepper"); then
 * bare-value inheritance for the parts that did not parse ("South
 * and product is Widget A" after "region is North").
 */
function parseOrBranch(
  branch: string,
  columns: ColumnInfo[],
  lastEquals: Filter | null,
): { filters: Filter[]; lastEquals: Filter | null } | { error: string } {
  const parts = mergeBetweenFragments(splitTopLevelAnd(branch));
  if (parts.length === 1) {
    const parsed = parseWhereCondition(parts[0], columns);
    if (!("error" in parsed)) {
      return {
        filters: parsed.filters,
        lastEquals:
          parsed.filters.length === 1 && parsed.filters[0].op === "="
            ? parsed.filters[0]
            : null,
      };
    }
    if (!parsed.soft) return { error: parsed.error };
    if (lastEquals) {
      const value = parts[0].trim().replace(/^["']|["']$/g, "");
      // "excluding" cannot hide inside an inherited value ("South
      // excluding East" is not a region) — it belongs outside the
      // where clause, or as an explicit "is not".
      const exclusion = /\b(?:excluding|except)\s+(.+)$/i.exec(value);
      if (exclusion) {
        return {
          error: `could not understand "excluding ${exclusion[1]}" inside a where clause — try "where ${lastEquals.column} is not ${exclusion[1]}"`,
        };
      }
      const inherited: Filter = { column: lastEquals.column, op: "=", value };
      return { filters: [inherited], lastEquals: inherited };
    }
    const firstText = columns.find((c) => c.type === "text");
    return {
      error: `could not tell what "${parts[0].trim()}" means — say the full condition, e.g. "where ${firstText?.name ?? "region"} is ${parts[0].trim()}"`,
    };
  }

  const branchFilters: Filter[] = [];
  let branchLastEquals: Filter | null = lastEquals;
  let softFailed = false;
  let hardError: string | null = null;
  for (const part of parts) {
    const parsed = parseWhereCondition(part, columns);
    if ("error" in parsed) {
      if (parsed.soft) softFailed = true;
      else hardError = parsed.error;
      break;
    }
    branchFilters.push(...parsed.filters);
    branchLastEquals =
      parsed.filters.length === 1 && parsed.filters[0].op === "="
        ? parsed.filters[0]
        : null;
  }
  if (hardError !== null) return { error: hardError };
  if (!softFailed) {
    return { filters: branchFilters, lastEquals: branchLastEquals };
  }
  // The "and" may sit inside a value — try the whole branch as one
  // condition before falling back to inheritance.
  const whole = parseWhereCondition(branch, columns);
  if (!("error" in whole)) {
    return {
      filters: whole.filters,
      lastEquals:
        whole.filters.length === 1 && whole.filters[0].op === "=" ? whole.filters[0] : null,
    };
  }
  const retry: Filter[] = [];
  let retryLastEquals: Filter | null = lastEquals;
  for (const part of parts) {
    const parsed = parseWhereCondition(part, columns);
    if ("error" in parsed) {
      if (!parsed.soft) return { error: parsed.error };
      if (!retryLastEquals) return { error: whole.error };
      const value = part.trim().replace(/^["']|["']$/g, "");
      const exclusion = /\b(?:excluding|except)\s+(.+)$/i.exec(value);
      if (exclusion) {
        return {
          error: `could not understand "excluding ${exclusion[1]}" inside a where clause — try "where ${retryLastEquals.column} is not ${exclusion[1]}"`,
        };
      }
      const inherited: Filter = { column: retryLastEquals.column, op: "=", value };
      retry.push(inherited);
      retryLastEquals = inherited;
      continue;
    }
    retry.push(...parsed.filters);
    retryLastEquals =
      parsed.filters.length === 1 && parsed.filters[0].op === "="
        ? parsed.filters[0]
        : null;
  }
  return { filters: retry, lastEquals: retryLastEquals };
}

/**
 * Parse a where clause that contains a top-level "or" into OR
 * groups (AND binds tighter, so "a and b or c" is (a and b) or c).
 * Returns null when there is no top-level "or" — the caller uses
 * the AND path instead.
 */
function parseOrClause(
  clause: string,
  columns: ColumnInfo[],
): { groups: Filter[][] } | { error: string } | null {
  const branches = splitTopLevelOr(clause);
  if (branches.length === 1) return null;
  const groups: Filter[][] = [];
  let lastEquals: Filter | null = null;
  for (const branch of branches) {
    const parsed = parseOrBranch(branch, columns, lastEquals);
    if ("error" in parsed) return { error: parsed.error };
    groups.push(parsed.filters);
    lastEquals = parsed.lastEquals;
  }
  return { groups };
}

/**
 * Columns whose known text/boolean values include `value`
 * (case-insensitive). Shared by the "in"/"for", "excluding" and
 * share-subset resolvers — a value that belongs to several columns
 * never silently picks one.
 */
function valueOwners(
  value: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
): ColumnInfo[] {
  return columns.filter((col, idx) => {
    if (col.type !== "text" && col.type !== "boolean") return false;
    return distinctValues(parsed, idx).has(value.toLowerCase());
  });
}

/**
 * The value's spelling as it appears in the sheet ("North", not
 * the lowercased "north" the parser matched on), so answers read
 * naturally.
 */
function sheetSpelling(
  value: string,
  column: ColumnInfo,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
): string {
  const idx = columns.indexOf(column);
  for (const row of parsed.rows) {
    const cell = (row[idx] ?? "").trim();
    if (cell.toLowerCase() === value.toLowerCase()) return cell;
  }
  return value;
}

/**
 * Find a trailing "excluding <value>" / "except <value>" outside
 * quotes — the marker word must not sit inside a quoted value
 * ("product is \"Salt excluding Pepper\"" is one value, not an
 * exclusion). The last marker wins. Returns the text before the
 * marker and the value, or null.
 */
function findTrailingExclusion(
  rest: string,
): { prefix: string; value: string } | null {
  let found: { index: number; length: number } | null = null;
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const m = /^(excluding|except)(?![a-z])/i.exec(rest.slice(i));
    if (m && (i === 0 || /[\s,;]/.test(rest[i - 1]!))) {
      found = { index: i, length: m[0].length };
      i += m[0].length - 1;
    }
  }
  if (!found) return null;
  const value = rest
    .slice(found.index + found.length)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (value === "") return null;
  return { prefix: rest.slice(0, found.index).trim(), value };
}

/**
 * Resolve an exclusion value to "!=" filters. One value is one
 * filter; several ("excluding North and South") are several — the
 * complement of a list is every item excluded. A value in no
 * column, or in several, is an error: "excluding" is unambiguous
 * filter intent, so there is nothing to leave alone.
 */
function resolveExclusionValues(
  value: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
): { filters: Filter[] } | { error: string } {
  const firstText = columns.find((c) => c.type === "text")?.name ?? "region";
  const whole = valueOwners(value, columns, parsed);
  if (whole.length === 1) {
    return {
      filters: [
        {
          column: whole[0].name,
          op: "!=",
          value: sheetSpelling(value, whole[0], columns, parsed),
        },
      ],
    };
  }
  if (whole.length > 1) {
    return {
      error: `"${value}" appears in several columns (${whole.map((c) => c.name).join(", ")}) — say which one, e.g. "where ${whole[0].name} is not ${value}"`,
    };
  }
  const parts = value.split(/\s+(?:and|or)\s+/i);
  if (parts.length > 1) {
    const filters: Filter[] = [];
    let owner: string | null = null;
    for (const part of parts) {
      const owners = valueOwners(part, columns, parsed);
      if (owners.length !== 1) {
        return {
          error: `could not find "${part}" in any column — say which rows to leave out, e.g. "where ${firstText} is not ${part}"`,
        };
      }
      if (owner === null) owner = owners[0].name;
      if (owners[0].name !== owner) {
        return {
          error: `"${part}" is in ${owners[0].name} but the other values are in ${owner} — an exclusion needs one column`,
        };
      }
      filters.push({
        column: owners[0].name,
        op: "!=",
        value: sheetSpelling(part, owners[0], columns, parsed),
      });
    }
    return { filters };
  }
  return {
    error: `could not find "${value}" in any column — say which rows to leave out, e.g. "where ${firstText} is not ${value}"`,
  };
}

/**
 * Resolve a trailing "in"/"for" value that lists several values
 * ("North and South", "North or South") into OR groups. The whole
 * value is tried first by the caller; this only runs when it has no
 * single owner. Returns null when the value is not a list (the
 * caller leaves it alone — "for each department", or a column name
 * like "salary" in "outliers in salary"), an error when it looks
 * like a list but cannot be resolved, and the groups otherwise. A
 * quoted value is never split: it was one value the sheet simply
 * does not have.
 */
function resolveInValueList(
  value: string,
  quoted: boolean,
  before: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
): { orGroups: Filter[][] } | { error: string } | null {
  // A column name as the value ("outliers in salary") is the column
  // being asked about, not a filter — leave it for the question parser.
  if (findColumns(value, columns).length > 0) return null;
  // "for each department" is the group-by phrase.
  if (/^each\b/i.test(value)) return null;
  // "compare rows in Jan vs Feb" (or "versus Feb"): the "in" belongs
  // to the comparison's phrasing, not to a filter.
  if (/\b(?:vs|versus)\b/i.test(value)) return null;
  // "how many outliers in profit", "how many duplicates in profit":
  // the "in" names the subject column those questions read — a word
  // that is not a column is their "no column named" abstention, not
  // a filter to resolve here.
  if (/\b(outlier|duplicate)s?\b/i.test(before)) return null;
  const firstText = columns.find((c) => c.type === "text")?.name ?? "region";
  const parts = quoted ? [value] : value.split(/\s+(?:and|or)\s+/i);
  if (parts.length === 1) {
    // A single unknown value: refuse rather than silently dropping
    // the filter — "total revenue in 2024" must not answer the
    // whole-sheet total as if nothing had been asked.
    return {
      error: `could not find "${value}" in any column — say which rows, e.g. "where ${firstText} is ${value}"`,
    };
  }
  const groups: Filter[][] = [];
  let owner: string | null = null;
  for (const part of parts) {
    const owners = valueOwners(part, columns, parsed);
    if (owners.length !== 1) {
      return {
        error: `could not find "${part}" in any column — say which rows, e.g. "where ${firstText} is ${part}"`,
      };
    }
    if (owner === null) owner = owners[0].name;
    if (owners[0].name !== owner) {
      return {
        error: `"${part}" is in ${owners[0].name} but the other values are in ${owner} — a list after "in" needs one column`,
      };
    }
    groups.push([
      {
        column: owners[0].name,
        op: "=",
        value: sheetSpelling(part, owners[0], columns, parsed),
      },
    ]);
  }
  return { orGroups: groups };
}

function extractFilters(question: string, parsed: ParsedCsv): FilterExtraction {
  const columns = inferSchema(parsed);
  let rest = question;
  const filters: Filter[] = [];
  const orGroups: Filter[][] = [];

  const where = /\bwhere\b/i.exec(rest);
  if (where) {
    const clause = rest.slice(where.index + where[0].length).trim();
    // An "or" changes the shape before any "and" parsing: AND
    // binds tighter, so "a and b or c" is (a and b) or c, and a
    // bare value inherits the most recent "=" filter.
    const orParsed = parseOrClause(clause, columns);
    if (orParsed && "error" in orParsed) {
      return { filters, orGroups, rest, error: orParsed.error };
    }
    if (orParsed) {
      orGroups.push(...orParsed.groups);
      rest = rest.slice(0, where.index).trim();
    } else {
      const parts = mergeBetweenFragments(splitTopLevelAnd(clause));
      let handled = false;
      if (parts.length > 1) {
        // Compound: "where region is North and product is Widget A".
        // Every part must parse as a condition; a hard failure (an
        // unknown column, a reversed range) is reported as-is, while
        // a soft failure (a bare word) means the "and" may sit inside
        // a value — "where product is Salt and Pepper" — so fall back
        // to reading the whole clause as one condition.
        const compound: Filter[] = [];
        let hardError: string | null = null;
        let softFailed = false;
        for (const part of parts) {
          const parsedCondition = parseWhereCondition(part, columns);
          if ("error" in parsedCondition) {
            if (parsedCondition.soft) softFailed = true;
            else hardError = parsedCondition.error;
            break;
          }
          compound.push(...parsedCondition.filters);
        }
        if (hardError !== null) {
          return { filters, orGroups, rest, error: hardError };
        }
        if (!softFailed) {
          filters.push(...compound);
          rest = rest.slice(0, where.index).trim();
          handled = true;
        }
      }
      if (!handled) {
        const parsed = parseWhereCondition(clause, columns);
        if ("error" in parsed) {
          return { filters, orGroups, rest, error: parsed.error };
        }
        filters.push(...parsed.filters);
        rest = rest.slice(0, where.index).trim();
      }
    }
  }

  // Trailing "excluding <value>" / "except <value>": the complement
  // of the "in" form — "total revenue excluding North" is region !=
  // North. It runs before the "in"/"for" loop so the two compose
  // ("for North excluding South" is North and not South), and an
  // exclusion placed before "where" still works, because the where
  // extractor only strips from "where" onward ("total revenue
  // excluding East where region is North or South").
  const exclusion = findTrailingExclusion(rest);
  if (exclusion) {
    const resolved = resolveExclusionValues(exclusion.value, columns, parsed);
    if ("error" in resolved) {
      return { filters, orGroups, rest, error: resolved.error };
    }
    filters.push(...resolved.filters);
    rest = exclusion.prefix;
  }

  // Trailing "in <value>" / "for <value>" with a known categorical value.
  // The LAST marker wins: "outliers in salary in Engineering" filters
  // on Engineering, not on "salary in Engineering" — the first "in"
  // belongs to the column phrase ("outliers in salary"), the filter
  // is the trailing one.
  for (const marker of ["in", "for"]) {
    const re = new RegExp(`^(.*)\\b${marker}\\s+([^,;]+?)\\s*$`, "i");
    const m = re.exec(rest);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    const owners = columns.filter((col, idx) => {
      if (col.type !== "text" && col.type !== "boolean") return false;
      return distinctValues(parsed, idx).has(value.toLowerCase());
    });
    if (owners.length === 1) {
      filters.push({ column: owners[0].name, op: "=", value });
      rest = rest.slice(0, m[1].length).trim();
    } else if (owners.length > 1) {
      return {
        filters,
        orGroups,
        rest,
        error: `"${value}" appears in several columns (${owners.map((c) => c.name).join(", ")}) — say which one, e.g. "where ${owners[0].name} is ${value}"`,
      };
    } else {
      // No owner: usually not a filter ("for each department", a
      // column name like "salary" in "outliers in salary") — but a
      // list of values ("in North and South") is a filter the old
      // code silently dropped, answering the whole sheet as if
      // nothing had been asked. Resolve the list, or refuse.
      const quoted = /^["'].*["']$/.test(m[2].trim());
      const list = resolveInValueList(value, quoted, m[1], columns, parsed);
      if (list && "error" in list) {
        return { filters, orGroups, rest, error: list.error };
      }
      if (list) {
        orGroups.push(...list.orGroups);
        rest = rest.slice(0, m[1].length).trim();
      }
      // Otherwise leave it: "for each", a column name, or a value
      // no other rule covers.
    }
  }

  return { filters, orGroups, rest };
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
  orGroups?: Filter[][],
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
      orGroups,
    },
  };
}

/**
 * Try to read a head-to-head group comparison ("compare total
 * revenue in North vs South", "total revenue North vs South",
 * "compare average salary in Engineering vs Data", "compare rows
 * in North vs South"). Returns null when the question shows no
 * head-to-head intent; otherwise a headtohead query, or an
 * abstention when the two sides or the target cannot be pinned
 * down.
 *
 * Both sides must be values of the same text column — "North vs
 * Widget A" spans two columns and has no single grouping to
 * compare. A bare aggregate reads as the total ("compare revenue
 * North vs South" compares total revenue); a "rows" question
 * compares row counts. The two sides must differ, and the group
 * column may be restated ("compare total revenue by region in
 * North vs South").
 *
 * Questions naming any period ("compare revenue Jan 2026 vs Feb
 * 2026") belong to the period comparison and are left alone, as
 * are correlation, share, percent, distribution and trend
 * questions that happen to use "vs".
 */
function tryParseHeadToHead(
  text: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  const vs = /\b(?:vs|versus)\b/.exec(norm);
  if (!vs) return null;
  // Any period mention belongs to the period comparison —
  // "compare revenue Jan vs Feb" must keep reaching it, and a
  // half-named period comparison must get its wording, not this
  // parser's.
  if (findPeriodMentions(norm).length > 0) return null;
  // A "vs" inside a question of another kind is that kind's
  // business, not a head-to-head — "correlation between revenue
  // vs units", "what share of revenue is North vs South".
  if (/\b(correlat\w*|share|percent|distribution|histogram|trend)\b/.test(norm)) {
    return null;
  }

  const left = norm.slice(0, vs.index).trim();
  const right = norm.slice(vs.index + vs[0].length).trim();
  if (left === "" || right === "") {
    return {
      ok: false,
      reason:
        "a head-to-head needs two groups named — e.g. 'compare total revenue in North vs South'",
    };
  }

  // The right side is one value, spelled as it appears in the
  // sheet ("South", "Widget B"); a leading "the" is just noise.
  const rightValue = right.replace(/^the\s+/, "");
  const sideB = resolveShareValue(rightValue, columns, parsed);
  if ("error" in sideB) {
    return {
      ok: false,
      reason: `could not tell which two groups to compare — ${sideB.error}`,
    };
  }

  // The left side ends with the other value ("... in North",
  // "... for Widget A", or bare "... North"): the longest known
  // categorical value the left side ends with wins, so "Widget A"
  // beats a shorter value and a multi-word value is never split.
  const escapeRegExp = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches: { column: ColumnInfo; value: string; prefix: string }[] = [];
  for (const col of columns) {
    if (col.type !== "text" && col.type !== "boolean") continue;
    const idx = columns.indexOf(col);
    for (const value of distinctValues(parsed, idx)) {
      const m = new RegExp(
        `(?:^|\\s)(?:in\\s+|for\\s+)?${escapeRegExp(value)}\\s*$`,
      ).exec(left);
      if (m) matches.push({ column: col, value, prefix: left.slice(0, m.index).trim() });
    }
  }
  if (matches.length === 0) {
    return {
      ok: false,
      reason:
        "could not tell which two groups to compare — say which rows, e.g. 'compare total revenue in North vs South'",
    };
  }
  const longest = Math.max(...matches.map((m) => m.value.length));
  const best = matches.filter((m) => m.value.length === longest);
  const owners = [
    ...new Map(best.map((m) => [m.column.name, m.column])).values(),
  ];
  if (owners.length > 1) {
    return {
      ok: false,
      reason: `"${best[0]!.value}" appears in several columns (${owners.map((c) => c.name).join(", ")}) — say which one, e.g. "where ${owners[0]!.name} is ${best[0]!.value}"`,
    };
  }
  const sideAMatch = best[0]!;
  const groupColumn = sideAMatch.column;
  if (sideB.filter.column !== groupColumn.name) {
    return {
      ok: false,
      reason: `"${sideB.filter.value}" is in ${sideB.filter.column} but the other side is in ${groupColumn.name} — a head-to-head needs one column; say which one, e.g. "where ${groupColumn.name} is ${sideB.filter.value}"`,
    };
  }
  const sideAValue = sheetSpelling(
    sideAMatch.value,
    groupColumn,
    columns,
    parsed,
  );
  const sideBValue = sideB.filter.value;
  if (sideAValue.toLowerCase() === sideBValue.toLowerCase()) {
    return {
      ok: false,
      reason: `both sides are ${sideAValue} — compare two different groups`,
    };
  }

  // The rest of the left side names the aggregate and the column
  // ("compare total revenue", "compare average salary", "compare
  // rows"); a restated group-by ("by region") is just the grouping
  // again, so it is dropped before the column is read.
  let rest = sideAMatch.prefix
    .replace(/\bcompare\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  rest = rest
    .replace(
      new RegExp(
        `\\b(?:by|per)\\s+${escapeRegExp(normalize(groupColumn.name))}\\b`,
      ),
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (/\brows?\b/.test(rest) && findColumns(rest, columns).length === 0) {
    return {
      ok: true,
      query: {
        kind: "headtohead",
        column: null,
        op: "count",
        groupColumn: groupColumn.name,
        sideA: sideAValue,
        sideB: sideBValue,
        filters,
        orGroups,
      },
    };
  }
  const op = detectAggregateOp(rest) ?? "sum";
  const candidates = findColumns(rest, columns).filter(
    (c) => c.name !== groupColumn.name,
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
      reason: `could not tell which column to compare — matches ${candidates.map((c) => c.name).join(", ")}`,
    };
  }
  const column = candidates[0]!;
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `comparing needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  return {
    ok: true,
    query: {
      kind: "headtohead",
      column: column.name,
      op,
      groupColumn: groupColumn.name,
      sideA: sideAValue,
      sideB: sideBValue,
      filters,
      orGroups,
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
  orGroups?: Filter[][],
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
        orGroups,
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
      orGroups,
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
/**
 * Resolve one subset value ("North") to its owning text column and
 * the value's spelling as it appears in the sheet. A value in no
 * column, or in several, is an error — guessing the column would
 * share out the wrong subset.
 */
function resolveShareValue(
  value: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
): { filter: Filter } | { error: string } {
  const owners = columns.filter((col, idx) => {
    if (col.type !== "text" && col.type !== "boolean") return false;
    return distinctValues(parsed, idx).has(value);
  });
  if (owners.length === 0) {
    return {
      error: `could not find "${value}" in any column — say which rows, e.g. "where ${columns.find((c) => c.type === "text")?.name ?? "region"} is ${value}"`,
    };
  }
  if (owners.length > 1) {
    return {
      error: `"${value}" appears in several columns (${owners.map((c) => c.name).join(", ")}) — say which one, e.g. "where ${owners[0].name} is ${value}"`,
    };
  }
  // Keep the value's spelling as it appears in the sheet ("North",
  // not the lowercased "north" the parser matched on), so answers
  // read naturally.
  const ownerIdx = columns.indexOf(owners[0]);
  let rawValue = value;
  for (const row of parsed.rows) {
    const cell = (row[ownerIdx] ?? "").trim();
    if (cell.toLowerCase() === value) {
      rawValue = cell;
      break;
    }
  }
  return { filter: { column: owners[0].name, op: "=", value: rawValue } };
}

/**
 * Resolve an "X or Y" subset ("North or South") into OR groups.
 * Every value must belong to the same text column — "North or
 * Widget A" spans two columns and has no single subset to share.
 * Returns null when there is no "or" in the text. The words for
 * the thing being counted ("rows", "employees") are stripped from
 * each part before resolving.
 */
function resolveShareOrValues(
  text: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
): { orGroups: Filter[][] } | { error: string } | null {
  const parts = text.split(/\s+or\s+/);
  if (parts.length === 1) return null;
  const countWords = new Set(["row", "rows", "employee", "employees"]);
  const groups: Filter[][] = [];
  let owner: string | null = null;
  for (const part of parts) {
    const value = part
      .split(" ")
      .filter((w) => w !== "" && !countWords.has(w))
      .join(" ");
    if (value === "") {
      return {
        error: `could not tell what "${part.trim()}" means — say which rows, e.g. "where ${columns.find((c) => c.type === "text")?.name ?? "region"} is ..."`,
      };
    }
    const resolved = resolveShareValue(value, columns, parsed);
    if ("error" in resolved) return { error: resolved.error };
    if (owner === null) owner = resolved.filter.column;
    if (resolved.filter.column !== owner) {
      return {
        error: `"${value}" is in ${resolved.filter.column} but the other values are in ${owner} — an "or" share needs one column; say which one, e.g. "where ${owner} is ${value}"`,
      };
    }
    groups.push([resolved.filter]);
  }
  return { orGroups: groups };
}

function tryParseShare(
  text: string,
  columns: ColumnInfo[],
  parsed: ParsedCsv,
  filters: Filter[],
  orGroups?: Filter[][],
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
    if (filters.length > 0 || (orGroups !== undefined && orGroups.length > 0)) {
      return { ok: true, query: { kind: "share", column: null, filters, orGroups } };
    }
    // "what share of rows are in North or South": no column named,
    // but an "or" list of values pins the subset down.
    const orValues = resolveShareOrValues(cleaned, columns, parsed);
    if (orValues && "error" in orValues) return { ok: false, reason: orValues.error };
    if (orValues) {
      return {
        ok: true,
        query: { kind: "share", column: null, filters, orGroups: orValues.orGroups },
      };
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
  let rest = stripColumnName(cleaned, column);
  if (rest !== "") {
    // "what share of revenue is North or South": an "or" list of
    // values is the subset. It cannot combine with a where clause
    // that already used "or" — one OR per share question.
    const orValues = resolveShareOrValues(rest, columns, parsed);
    if (orValues && "error" in orValues) return { ok: false, reason: orValues.error };
    if (orValues) {
      if (orGroups !== undefined && orGroups.length > 0) {
        return {
          ok: false,
          reason:
            "a share can use \"or\" once — combine the conditions with \"where\", e.g. 'what share of revenue where region is North or South'",
        };
      }
      return {
        ok: true,
        query: {
          kind: "share",
          column: column.name,
          filters: allFilters,
          orGroups: orValues.orGroups,
        },
      };
    }
    const resolved = resolveShareValue(rest, columns, parsed);
    if ("error" in resolved) return { ok: false, reason: resolved.error };
    allFilters.push(resolved.filter);
  }
  if (allFilters.length === 0 && (orGroups === undefined || orGroups.length === 0)) {
    return {
      ok: false,
      reason:
        "a share needs a group to compare — say which rows, e.g. 'what share of revenue is North'",
    };
  }
  return { ok: true, query: { kind: "share", column: column.name, filters: allFilters, orGroups } };
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
  orGroups?: Filter[][],
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
    query: { kind: "distinct", column: distinct[0].name, filters, orGroups, limit: 20 },
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
  orGroups?: Filter[][],
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
    query: { kind: "mode", column: distinct[0].name, filters, orGroups },
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
/**
 * Try to read a distribution question ("distribution of salary",
 * "histogram of revenue", "show distribution of age"). Returns null
 * when the question shows no distribution intent; otherwise a
 * distribution query, or an abstention when the column cannot be
 * pinned down or is not numeric — a histogram of a text column has
 * no bins to draw.
 */
function tryParseDistribution(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\b(distribution|histogram)\b/.test(norm)) return null;
  const filler = new Set([
    "show",
    "me",
    "the",
    "distribution",
    "histogram",
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
      reason: `could not tell which column to chart — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  const column = distinct[0];
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `a distribution needs a numeric column — "${column.name}" is ${column.type}; try e.g. "distribution of salary"`,
    };
  }
  return {
    ok: true,
    query: { kind: "distribution", column: column.name, filters, orGroups },
  };
}

function tryParseDistinctCount(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
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
    query: { kind: "distinctCount", column: distinct[0].name, filters, orGroups },
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
  orGroups?: Filter[][],
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
    query: { kind: "aboveBelow", column: column.name, direction, baseline, filters, orGroups },
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
  orGroups?: Filter[][],
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
    const rest = stripColumnName(cleaned, column);
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
    query: { kind: "missing", column: column?.name ?? null, filters, orGroups, listRows },
  };
}

/**
 * Try to read an outlier question ("how many outliers in revenue",
 * "which columns have outliers", "show outliers in revenue").
 * Returns null when the question shows no outlier intent; otherwise
 * an outliers query, or an abstention when the column cannot be
 * pinned down or is not numeric.
 *
 * Three shapes, mirroring the missing-values questions:
 * - one column, counted ("how many outliers in revenue") —
 *   "how many"/"count" wins over the row noun, so this counts
 *   instead of listing;
 * - one column, listed ("show outliers in revenue", "which rows
 *   are outliers in salary") — the rows themselves, first 10;
 * - no column ("which columns have outliers") — a report over
 *   every numeric column. Listing with no column abstains: there is
 *   no one column to list. A grouped question ("outliers in revenue
 *   by region") abstains, like missing values — it is a per-group
 *   question the engine does not answer.
 */
function tryParseOutliers(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\boutliers?\b/.test(norm)) return null;
  if (/\bby\b|\bper\b|\bgroup\b/.test(norm)) {
    return {
      ok: false,
      reason:
        "an outlier question asks about one column — try e.g. 'how many outliers in revenue'",
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
    "outlier",
    "outliers",
    "for",
    "all",
    "find",
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
    if (column.type !== "integer" && column.type !== "number") {
      return {
        ok: false,
        reason: `outliers need a numeric column — "${column.name}" is ${column.type}`,
      };
    }
    // Anything left after removing the column name is a word the
    // sheet does not explain — refuse rather than dropping it.
    const rest = stripColumnName(cleaned, column);
    if (rest !== "") {
      return {
        ok: false,
        reason: `could not understand "${rest}" in the question — try e.g. 'how many outliers in ${column.name}'`,
      };
    }
  } else if (cleaned !== "") {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }

  // "how many"/"count" counts, even when the question also says
  // "rows" ("how many rows are outliers in revenue"). Otherwise a
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
        "listing outlier rows needs one column — try e.g. 'show outliers in revenue'",
    };
  }
  return {
    ok: true,
    query: { kind: "outliers", column: column?.name ?? null, filters, orGroups, listRows },
  };
}

/**
 * Try to read a duplicate question ("how many duplicate rows",
 * "which columns have duplicates", "show duplicates in product").
 * Returns null when the question shows no duplicate intent;
 * otherwise a duplicates query, or an abstention when the column
 * cannot be pinned down.
 *
 * Three shapes, mirroring the missing-values and outlier questions:
 * - one column, counted ("how many duplicate products") — "how
 *   many"/"count" wins over the row noun, so this counts instead
 *   of listing;
 * - one column, listed ("show duplicates in product", "which rows
 *   are duplicates in region") — the duplicate rows themselves,
 *   first 10;
 * - no column ("how many duplicate rows", "which columns have
 *   duplicates") — a whole-sheet report: the exact duplicate rows
 *   plus a per-column count over every column. Listing with no
 *   column lists the exact duplicate rows. A grouped question
 *   ("duplicate products by region") abstains, like missing values
 *   and outliers — it is a per-group question the engine does not
 *   answer.
 */
function tryParseDuplicates(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\bduplicat\w*\b|\brepeat\w*\b/.test(norm)) return null;
  if (/\bby\b|\bper\b|\bgroup\b/.test(norm)) {
    return {
      ok: false,
      reason:
        "a duplicate question asks about one column — try e.g. 'how many duplicate rows'",
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
    "duplicate",
    "duplicates",
    "duplicated",
    "repeat",
    "repeats",
    "repeated",
    "repeating",
    "exact",
    "for",
    "all",
    "find",
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
    const rest = stripColumnName(cleaned, column);
    if (rest !== "") {
      return {
        ok: false,
        reason: `could not understand "${rest}" in the question — try e.g. 'how many duplicates in ${column.name}'`,
      };
    }
  } else if (cleaned !== "") {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }

  // "how many"/"count" counts, even when the question also says
  // "rows" ("how many duplicate rows"). Otherwise a show/list/
  // which-rows phrasing lists the rows. Unlike missing values and
  // outliers, listing needs no column: with none named, the exact
  // duplicate rows are listed.
  const wantsCount = /\bhow many\b|\bcount\b/.test(norm);
  const listRows =
    !wantsCount &&
    (/^\s*(show|list)\b/.test(norm) ||
      (/\bwhich\b/.test(norm) && /\brows?\b/.test(norm)));
  return {
    ok: true,
    query: { kind: "duplicates", column: column?.name ?? null, filters, orGroups, listRows },
  };
}

function tryParsePercentile(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
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
    query: { kind: "percentile", column: column.name, p, filters, orGroups },
  };
}

/** Ordinal words ("first" … "twentieth") and their ranks. */
const WORD_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
};

/**
 * Try to read a group-rank question ("second highest total revenue
 * by region", "which region has the second highest total revenue").
 * Returns null when the question shows no group-rank intent;
 * otherwise a rank query with `groupBy` set, or an abstention when
 * the rank, the group or the value column cannot be pinned down.
 *
 * A group rank ranks per-group aggregates, not rows: with region
 * totals North 389.97 / South 649.77 / East 624.91 / West 124.95
 * the 2nd highest total revenue by region is 624.91, held by East.
 * Ties share the rank, like a plain rank — two regions on the same
 * total both hold it. A bare aggregate word reads as the total — a
 * group is a set of rows, so its total is the natural reading, the
 * same convention as groupextreme; an explicit "average"/"median"/
 * "minimum"/"maximum" overrides it. Only one group column at a
 * time — "by region and product" is two dimensions and is refused
 * with a pointer to one.
 *
 * The question is read positionally — ordinal, direction, optional
 * aggregate word, value column — so "minimum" in the aggregate slot
 * is an op and in the direction slot is the low end, never both at
 * once: "second highest minimum revenue by region" ranks the
 * per-group minima from the top.
 *
 * Checked before the plain rank parser, which would otherwise
 * abstain on the "by region" tail ("a rank question asks about one
 * column") instead of answering the question asked.
 */
function tryParseGroupRank(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  const direction = /\b(highest|largest|biggest|greatest|maximum)\b/.test(norm)
    ? "highest"
    : /\b(lowest|smallest|least|minimum)\b/.test(norm)
      ? "lowest"
      : null;
  if (direction === null) return null;
  const numeric = /(\d{1,3})(?:st|nd|rd|th)\b/.exec(norm);
  const word = Object.keys(WORD_ORDINALS).find((w) => new RegExp(`\\b${w}\\b`).test(norm));
  const n = numeric ? Number(numeric[1]) : word ? WORD_ORDINALS[word]! : null;
  if (n === null) return null;
  if (n < 1) {
    return {
      ok: false,
      reason: `a rank starts at 1 — try e.g. 'second highest total revenue by region'`,
    };
  }

  // Form 2: "which region has the second highest total revenue" —
  // the "which <column> has the" subject is the group column.
  let groupBy: ColumnInfo | null = null;
  let rest = norm;
  const which = /\b(?:which|what)\s+(.+?)\s+(?:has|have)\s+the\s+/.exec(norm);
  if (which) {
    const hits = findColumns(which[1]!, columns);
    const distinct = [...new Map(hits.map((c) => [c.name, c])).values()];
    if (distinct.length === 0) return null;
    if (distinct.length > 1) {
      return {
        ok: false,
        reason: `could not tell which group to rank — matches ${distinct.map((c) => c.name).join(", ")}`,
      };
    }
    groupBy = distinct[0]!;
    rest = norm.slice(which[0]!.length).trim();
  } else {
    const extracted = extractGroupBy(norm, columns);
    if (extracted.groupBy.length === 0) return null;
    if (extracted.error) return { ok: false, reason: extracted.error };
    if (extracted.groupBy.length > 1) {
      return {
        ok: false,
        reason: `a group rank ranks one dimension at a time — try e.g. 'second highest total revenue by ${extracted.groupBy[0]!.name}'`,
      };
    }
    groupBy = extracted.groupBy[0]!;
    rest = extracted.rest;
  }

  // Positional read: ordinal, direction, optional aggregate word,
  // then the value column ("second highest total revenue",
  // "the 3rd lowest average salary", "what is the 2nd largest
  // median units").
  const ordinalWords = Object.keys(WORD_ORDINALS).join("|");
  const directionWords = "highest|largest|biggest|greatest|maximum|lowest|smallest|least|minimum";
  const shaped = new RegExp(
    `^(?:what\\s+is\\s+the\\s+|the\\s+)?(?:\\d{1,3}(?:st|nd|rd|th)|${ordinalWords})\\s+(?:${directionWords})\\s+(?:(total|sum|average|mean|median|minimum|maximum)\\s+)?(.*)$`,
  ).exec(rest);
  if (!shaped) {
    return {
      ok: false,
      reason: `could not read the group rank in "${rest}" — try e.g. 'second highest total revenue by ${groupBy.name}'`,
    };
  }
  const aggWord = shaped[1];
  const op: Exclude<AggregateOp, "count"> =
    aggWord === "average" || aggWord === "mean"
      ? "mean"
      : aggWord === "median"
        ? "median"
        : aggWord === "minimum"
          ? "min"
          : aggWord === "maximum"
            ? "max"
            : "sum";
  const valuePhrase = shaped[2]!.trim();
  if (valuePhrase === "") {
    return {
      ok: false,
      reason: `a group rank needs a value column — try e.g. 'second highest total revenue by ${groupBy.name}'`,
    };
  }
  const valueHits = findColumns(valuePhrase, columns);
  const valueDistinct = [...new Map(valueHits.map((c) => [c.name, c])).values()];
  if (valueDistinct.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}${didYouMean(valuePhrase, columns)}`,
    };
  }
  if (valueDistinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to rank — matches ${valueDistinct.map((c) => c.name).join(", ")}`,
    };
  }
  const column = valueDistinct[0]!;
  if (column.name === groupBy.name) {
    return {
      ok: false,
      reason: `a group rank ranks one column across another — "${column.name}" can't group by itself`,
    };
  }
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `a group rank needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  // Anything left after removing the column name is a word the
  // sheet does not explain — refuse rather than dropping it.
  const leftover = stripColumnName(valuePhrase, column);
  if (leftover !== "") {
    return {
      ok: false,
      reason: `could not understand "${leftover}" in the question — try e.g. 'second highest total ${column.name} by ${groupBy.name}'`,
    };
  }
  return {
    ok: true,
    query: { kind: "rank", column: column.name, n, direction, groupBy: groupBy.name, op, filters, orGroups },
  };
}

/**
 * Try to read an ordinal-rank question ("second highest salary",
 * "3rd lowest revenue", "what is the 2nd largest sale"). Returns
 * null when the question shows no rank intent; otherwise a rank
 * query, or an abstention when the rank or the column cannot be
 * pinned down. A rank is one numeric column, ungrouped — "second
 * highest salary by department" is a group-rank question, handled
 * by tryParseGroupRank before this runs.
 *
 * The rank counts distinct values, not rows: with salaries 98,000 /
 * 95,000 / 95,000 / 91,000 the 2nd highest salary is 95,000 and the
 * answer says 2 rows hold it. Counting rows would make the rank
 * depend on which tied row the sort happened to put first, so a
 * tie would give a different answer for the same question. A rank
 * past the end ("5th highest" with only 4 distinct values) is
 * answered by the engine, not the parser — the parser cannot know
 * how many distinct values the sheet holds.
 *
 * This is checked before the generic aggregate fallback, which
 * would otherwise read "second highest salary" as a plain maximum
 * and silently answer with the highest row — the exact wrong
 * answer this question kind exists to avoid.
 */
function tryParseRank(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  const direction = /\b(highest|largest|biggest|greatest|maximum)\b/.test(norm)
    ? "highest"
    : /\b(lowest|smallest|least|minimum)\b/.test(norm)
      ? "lowest"
      : null;
  if (direction === null) return null;
  const numeric = /(\d{1,3})(?:st|nd|rd|th)\b/.exec(norm);
  const word = Object.keys(WORD_ORDINALS).find((w) => new RegExp(`\\b${w}\\b`).test(norm));
  const n = numeric ? Number(numeric[1]) : word ? WORD_ORDINALS[word]! : null;
  if (n === null) return null;
  if (n < 1) {
    return {
      ok: false,
      reason: `a rank starts at 1 — try e.g. 'second highest salary'`,
    };
  }
  if (/\bby\b|\bper\b|\bgroup\b/.test(norm)) {
    return {
      ok: false,
      reason:
        "a rank question asks about one column — try e.g. 'second highest salary'",
    };
  }

  const filler = new Set([
    "what",
    "is",
    "the",
    "of",
    "for",
    "show",
    "find",
    "me",
    "highest",
    "largest",
    "biggest",
    "greatest",
    "maximum",
    "lowest",
    "smallest",
    "least",
    "minimum",
    ...Object.keys(WORD_ORDINALS),
  ]);
  const cleaned = norm
    .replace(/\b\d{1,3}(?:st|nd|rd|th)\b/g, " ")
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
      reason: `could not tell which column to rank — matches ${distinct.map((c) => c.name).join(", ")}`,
    };
  }
  const column = distinct[0];
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `a rank needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  // Anything left after removing the column name is a word the
  // sheet does not explain — refuse rather than dropping it.
  const rest = stripColumnName(cleaned, column);
  if (rest !== "") {
    return {
      ok: false,
      reason: `could not understand "${rest}" in the question — try e.g. 'second highest ${column.name}'`,
    };
  }
  return {
    ok: true,
    query: { kind: "rank", column: column.name, n, direction, filters, orGroups },
  };
}

/**
 * Try to read a group-extreme question ("which region has the
 * highest total revenue", "which product has the lowest average
 * units", "which department has the most salary"). Returns null
 * when the question shows no such intent, or when the "which ...
 * has" subject is not a column at all — "which employee has the
 * highest salary" is a row question, and it falls through to the
 * row-ranking fallback instead of abstaining here. Otherwise a
 * groupextreme query, or an abstention when the group or the value
 * column cannot be pinned down. A bare "highest revenue" reads as
 * the highest total — a group is a set of rows, so its total is
 * the natural reading; an explicit aggregate word (average/median/
 * minimum/maximum) overrides it.
 */
function tryParseGroupExtreme(
  text: string,
  columns: ColumnInfo[],
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  const m =
    /\b(?:which|what)\s+(.+?)\s+(?:has|have)\s+the\s+(highest|lowest|most|least|biggest|smallest)\b\s*(.*)$/.exec(
      norm,
    );
  if (!m) return null;
  const groupPhrase = m[1]!;
  const extreme = m[2]!;
  const tail = m[3]!;
  const direction =
    extreme === "lowest" || extreme === "least" || extreme === "smallest" ? "lowest" : "highest";
  const groupHits = findColumns(groupPhrase, columns);
  const groupDistinct = [...new Map(groupHits.map((c) => [c.name, c])).values()];
  if (groupDistinct.length === 0) return null;
  if (groupDistinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which group to compare — matches ${groupDistinct.map((c) => c.name).join(", ")}`,
    };
  }
  const groupBy = groupDistinct[0]!;
  // An optional aggregate word before the value column.
  const aggMatch = /^(total|sum|average|mean|median|minimum|maximum)\b\s*(.*)$/.exec(tail);
  const aggWord = aggMatch?.[1];
  const op: Exclude<AggregateOp, "count"> =
    aggWord === "average" || aggWord === "mean"
      ? "mean"
      : aggWord === "median"
        ? "median"
        : aggWord === "minimum"
          ? "min"
          : aggWord === "maximum"
            ? "max"
            : "sum";
  const valuePhrase = (aggMatch ? aggMatch[2]! : tail).trim();
  if (valuePhrase === "") {
    return {
      ok: false,
      reason: `a group extreme needs a value column — try e.g. 'which ${groupBy.name} has the highest total revenue'`,
    };
  }
  const valueHits = findColumns(valuePhrase, columns);
  const valueDistinct = [...new Map(valueHits.map((c) => [c.name, c])).values()];
  if (valueDistinct.length === 0) {
    return {
      ok: false,
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}${didYouMean(valuePhrase, columns)}`,
    };
  }
  if (valueDistinct.length > 1) {
    return {
      ok: false,
      reason: `could not tell which column to compare — matches ${valueDistinct.map((c) => c.name).join(", ")}`,
    };
  }
  const column = valueDistinct[0]!;
  if (column.name === groupBy.name) {
    return {
      ok: false,
      reason: `a group extreme compares one column across another — "${column.name}" can't group by itself`,
    };
  }
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `a group extreme needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  // Anything left after removing the column name is a word the
  // sheet does not explain — refuse rather than dropping it.
  const rest = stripColumnName(valuePhrase, column);
  if (rest !== "") {
    return {
      ok: false,
      reason: `could not understand "${rest}" in the question — try e.g. 'which ${groupBy.name} has the ${direction === "highest" ? "highest" : "lowest"} ${column.name}'`,
    };
  }
  return {
    ok: true,
    query: { kind: "groupextreme", groupBy: groupBy.name, column: column.name, op, direction, filters, orGroups },
  };
}

/**
 * Try to read a cumulative question ("cumulative revenue by month",
 * "running total of revenue by quarter"). Returns null when the
 * question shows no cumulative intent; otherwise a cumulative query,
 * or an abstention when the period, the date column or the target
 * column cannot be pinned down. A running total is always a sum —
 * a cumulative average, minimum or maximum is not a total of
 * anything, so those words abstain instead of answering with the
 * plain total. Unlike a trend, which fits a line over the periods,
 * this keeps the running sum after each period.
 */
function tryParseCumulative(
  text: string,
  columns: ColumnInfo[],
  bucket: TimeBucket | null,
  filters: Filter[],
  orGroups?: Filter[][],
): ParseResult | null {
  const norm = normalize(text);
  if (!/\bcumulative\b|\brunning total\b/.test(norm)) return null;
  if (!bucket) {
    return {
      ok: false,
      reason: "a running total needs a period — try e.g. 'cumulative revenue by month'",
    };
  }
  const dates = columns.filter((c) => c.type === "date");
  if (dates.length === 0) {
    return {
      ok: false,
      reason: `a running total over time needs a date column — columns are: ${columns.map((c) => c.name).join(", ")}`,
    };
  }
  if (dates.length > 1) {
    return {
      ok: false,
      reason: `could not tell which date column to total by — matches ${dates.map((c) => c.name).join(", ")}`,
    };
  }
  const dateColumn = dates[0];
  const op = detectAggregateOp(norm);
  if (op && op !== "sum") {
    return {
      ok: false,
      reason: `a running total needs a total — a cumulative ${op} has no running sum; try a trend for the ${op} instead`,
    };
  }

  // Strip the cumulative wording, the period word and filler,
  // leaving the column name ("running total of revenue by month"
  // -> "revenue"). Bucket aliases ("monthly") are stripped too.
  const filler = new Set([
    "cumulative",
    "running",
    "total",
    "sum",
    "of",
    "by",
    "per",
    "over",
    "time",
    "the",
    "what",
    "how",
    "much",
    "is",
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
      reason: `could not tell which column to total — matches ${candidates.map((c) => c.name).join(", ")}`,
    };
  }
  const column = candidates[0];
  if (column.type !== "integer" && column.type !== "number") {
    return {
      ok: false,
      reason: `a running total needs a numeric column — "${column.name}" is ${column.type}`,
    };
  }
  return {
    ok: true,
    query: {
      kind: "cumulative",
      column: column.name,
      dateColumn: dateColumn.name,
      bucket,
      filters,
      orGroups,
    },
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
  orGroups?: Filter[][],
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
      orGroups,
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
  // Only set when a where clause actually used "or": an empty
  // array would change every parsed query's shape for no reason.
  const orGroups = extracted.orGroups.length > 0 ? extracted.orGroups : undefined;

  // Head-to-head group comparison: two groups of one column
  // ("compare total revenue in North vs South"). Once the question
  // shows head-to-head intent it is parsed here or abstained —
  // falling through would answer the plain total instead of the
  // comparison asked for, and the period comparison below would
  // read the "vs" as two periods.
  const headToHead = tryParseHeadToHead(extracted.rest, columns, parsed, filters, orGroups);
  if (headToHead) return headToHead;

  // Period comparison: two named periods ("compare revenue Jan 2026
  // vs Feb 2026"). Once the question shows comparison intent it is
  // parsed here or abstained — falling through would answer the
  // plain total instead of the comparison asked for.
  const comparison = tryParseComparison(extracted.rest, columns, parsed, filters, orGroups);
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
  const trend = tryParseTrend(timeBucket.rest, columns, bucket, filters, orGroups);
  if (trend) return trend;

  // Cumulative: a column's running total over a time period
  // ("cumulative revenue by month"). Once the question shows
  // cumulative intent it is parsed here or abstained — falling
  // through would answer the plain monthly grouping instead of
  // the running total asked for.
  const cumulative = tryParseCumulative(timeBucket.rest, columns, bucket, filters, orGroups);
  if (cumulative) return cumulative;

  // Share: a filtered subset's total as a share of the whole sheet.
  // Once the question shows share intent it is parsed here or
  // abstained — falling through would answer the plain total instead
  // of the share asked for.
  const share = tryParseShare(timeBucket.rest, columns, parsed, filters, orGroups);
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
  const mode = tryParseMode(timeBucket.rest, columns, filters, orGroups);
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
  const distinctCount = tryParseDistinctCount(timeBucket.rest, columns, filters, orGroups);
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
  const percentile = tryParsePercentile(timeBucket.rest, columns, filters, orGroups);
  if (percentile) {
    if (bucket) {
      return {
        ok: false,
        reason: "a percentile can't be grouped by a time period — ask about the whole sheet, e.g. '90th percentile of salary'",
      };
    }
    return percentile;
  }

  // Group rank: the nth distinct per-group aggregate from the top
  // or the bottom ("second highest total revenue by region",
  // "which region has the second highest total revenue"). Checked
  // before the plain rank parser, which would otherwise abstain on
  // the "by region" tail instead of answering the question asked.
  const groupRank = tryParseGroupRank(timeBucket.rest, columns, filters, orGroups);
  if (groupRank) {
    if (bucket) {
      return {
        ok: false,
        reason: "a group rank can't be grouped by a time period — ask about the whole sheet, e.g. 'second highest total revenue by region'",
      };
    }
    return groupRank;
  }

  // Rank: one column's nth distinct value from the top or the
  // bottom ("second highest salary", "3rd lowest revenue").
  // Checked before the generic aggregate fallback, which would
  // otherwise read "second highest salary" as a plain maximum and
  // answer with the highest row — silently wrong.
  const rank = tryParseRank(timeBucket.rest, columns, filters, orGroups);
  if (rank) {
    if (bucket) {
      return {
        ok: false,
        reason: "a rank can't be grouped by a time period — ask about the whole sheet, e.g. 'second highest salary'",
      };
    }
    return rank;
  }

  // Above/below average: rows on one side of a column's own mean or
  // median ("rows with revenue above average"). Checked before the
  // generic aggregate fallback, which would otherwise read "average"
  // as a plain mean and answer the average itself.
  const aboveBelow = tryParseAboveBelow(timeBucket.rest, columns, filters, orGroups);
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
  const missing = tryParseMissing(timeBucket.rest, columns, filters, orGroups);
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

  // Outliers: a count per column, a whole-sheet report, or the rows
  // themselves ("show outliers in revenue"). Checked right after
  // missing values, before the distinct-values listing and the
  // generic aggregate fallback, which would otherwise read
  // "outliers" as nothing and answer a count of rows.
  const outliers = tryParseOutliers(timeBucket.rest, columns, filters, orGroups);
  if (outliers) {
    if (bucket) {
      return {
        ok: false,
        reason:
          "outliers can't be grouped by a time period — ask about the whole sheet, e.g. 'how many outliers in revenue'",
      };
    }
    return outliers;
  }

  // Duplicates: a count per column, a whole-sheet report, or the
  // rows themselves ("show duplicate rows"). Checked right after
  // outliers, before the distinct-values listing and the generic
  // aggregate fallback, which would otherwise read "duplicates"
  // as nothing and answer a count of rows.
  const duplicates = tryParseDuplicates(timeBucket.rest, columns, filters, orGroups);
  if (duplicates) {
    if (bucket) {
      return {
        ok: false,
        reason:
          "duplicates can't be grouped by a time period — ask about the whole sheet, e.g. 'how many duplicate rows'",
      };
    }
    return duplicates;
  }

  // Distinct values: every distinct value of one column, with row
  // counts. Checked before the generic "list/show rows" fallback
  // below, which would otherwise answer with rows instead.
  const distinct = tryParseDistinct(timeBucket.rest, columns, filters, orGroups);
  if (distinct) {
    if (bucket) {
      return {
        ok: false,
        reason: "distinct values can't be grouped by a time period — ask about the whole sheet, e.g. 'list unique regions'",
      };
    }
    return distinct;
  }

  // Distribution: a numeric column binned into a histogram
  // ("distribution of salary", "histogram of revenue"). Checked
  // before the generic aggregate fallback, which would otherwise
  // read "distribution" as nothing and abstain with a less useful
  // reason.
  const distribution = tryParseDistribution(timeBucket.rest, columns, filters, orGroups);
  if (distribution) {
    if (bucket) {
      return {
        ok: false,
        reason: "a distribution can't be grouped by a time period — ask about the whole sheet, e.g. 'distribution of salary'",
      };
    }
    return distribution;
  }

  // Correlation: two numeric columns, no grouping or ranking.
  const correlation = tryParseCorrelation(timeBucket.rest, columns, filters, orGroups);
  if (correlation) {
    if (bucket) {
      return {
        ok: false,
        reason: "correlation can't be grouped by a time period — ask about two columns, e.g. 'correlation between revenue and units'",
      };
    }
    return correlation;
  }

  // Group extreme: one group's aggregate beats every other
  // ("which region has the highest total revenue"). Checked before
  // the top-N fallback, which would otherwise read "highest" as a
  // ranking word and fail to tell the group column from the value
  // column. A "which ... has" subject that is not a column falls
  // through to the row ranking below ("which employee has the
  // highest salary" lists the top row).
  const groupExtreme = tryParseGroupExtreme(timeBucket.rest, columns, filters, orGroups);
  if (groupExtreme) {
    if (bucket) {
      return {
        ok: false,
        reason: "a group extreme can't be grouped by a time period — ask about the whole sheet, e.g. 'which region has the highest total revenue'",
      };
    }
    return groupExtreme;
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
        orGroups,
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
    return { ok: true, query: { kind: "count", filters, orGroups } };
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
        orGroups,
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
    ((filters.length > 0 || (orGroups !== undefined && orGroups.length > 0)) && !op)
  ) {
    return {
      ok: true,
      query: { kind: "rows", filters, orGroups, limit: 10, sort: sort.sort ?? undefined },
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
      reason: `no column named in the question — columns are: ${columns.map((c) => c.name).join(", ")}${didYouMean(text, columns)}`,
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
        orGroups,
        bucket: bucket ?? undefined,
      },
    };
  }
  return { ok: true, query: { kind: "aggregate", column: column.name, op, filters, orGroups } };
}
