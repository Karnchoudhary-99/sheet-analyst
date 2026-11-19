/**
 * Time bucketing: collapse a date cell into the period it belongs to
 * ("2026-01-05" -> "Jan 2026" for a monthly bucket) so questions like
 * "total revenue by month" can group rows over time.
 *
 * Dates are parsed the same way the schema infers them (see
 * schema.ts): ISO `YYYY-MM-DD` with an optional time part, or
 * day-first `DD/MM/YYYY`. Parsing uses UTC throughout so a bucket
 * never depends on the machine's timezone. Invalid dates (e.g.
 * 2026-02-30) are rejected, not silently shifted.
 */

export type TimeBucket = "day" | "week" | "month" | "quarter" | "year";

/** Bucket words the question parser accepts, including aliases. */
export const BUCKET_WORDS: Record<string, TimeBucket> = {
  day: "day",
  daily: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  quarter: "quarter",
  quarterly: "quarter",
  year: "year",
  yearly: "year",
  annual: "year",
};

/** Time words the parser recognises but cannot bucket — asking for one abstains. */
export const UNSUPPORTED_BUCKET_WORDS = new Set([
  "decade",
  "hour",
  "minute",
  "second",
  "century",
]);

export interface ParsedDate {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DMY_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Parse a date cell into year/month/day, or null when it is not a
 * date in one of the accepted shapes. A date that cannot exist
 * (2026-02-30) is null — `Date.UTC` would otherwise roll it over
 * into March and bucket it wrong.
 */
export function parseDate(value: string): ParsedDate | null {
  const v = value.trim();
  const iso = ISO_DATE.exec(v);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return validDate(year, month, day) ? { year, month, day } : null;
  }
  const dmy = DMY_DATE.exec(v);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    return validDate(year, month, day) ? { year, month, day } : null;
  }
  return null;
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * ISO-8601 week number (1-53) for a date: the week with the year's
 * first Thursday is week 1. Computed in UTC.
 */
export function isoWeek(d: ParsedDate): number {
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day));
  // Shift to the Thursday of this week, then count Thursdays.
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604800000);
  return week;
}

/** The period a date falls in. `key` sorts chronologically; `label` is what answers show. */
export interface DateBucket {
  key: string;
  label: string;
}

export function bucketDate(value: string, bucket: TimeBucket): DateBucket | null {
  const d = parseDate(value);
  if (!d) return null;
  switch (bucket) {
    case "day":
      return {
        key: `${d.year}-${pad2(d.month)}-${pad2(d.day)}`,
        label: `${d.year}-${pad2(d.month)}-${pad2(d.day)}`,
      };
    case "week": {
      // A week straddling New Year belongs to the year of its
      // Thursday, so the key uses the ISO week-year, not the
      // calendar year of the date itself.
      const date = new Date(Date.UTC(d.year, d.month - 1, d.day));
      const day = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - day + 3);
      const weekYear = date.getUTCFullYear();
      const week = isoWeek(d);
      return { key: `${weekYear}-W${pad2(week)}`, label: `${weekYear}-W${pad2(week)}` };
    }
    case "month":
      return {
        key: `${d.year}-${pad2(d.month)}`,
        label: `${MONTH_NAMES[d.month - 1]} ${d.year}`,
      };
    case "quarter": {
      const q = Math.floor((d.month - 1) / 3) + 1;
      return { key: `${d.year}-Q${q}`, label: `Q${q} ${d.year}` };
    }
    case "year":
      return { key: `${d.year}`, label: `${d.year}` };
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Named periods ("Jan 2026", "Q1 2026", "2026") for comparison questions
// ("compare revenue Jan 2026 vs Feb 2026"). A period is a bucket plus a
// chronological key in the same shape `bucketDate` produces, so the
// engine can test membership by bucketing each row's date cell.
// ---------------------------------------------------------------------------

/** A named period: month, quarter or year, with the year optional. */
export interface PeriodSpec {
  bucket: Exclude<TimeBucket, "day" | "week">;
  /** Chronological key, same shape as `bucketDate` keys ("2026-01", "2026-Q1", "2026"). */
  key: string;
  label: string;
  /** The year the period belongs to, when the question named one. */
  year?: number;
}

/** One period mention found in a question, with its span so the parser can strip it. */
export interface PeriodMention {
  spec: PeriodSpec;
  /** Character offsets into the (normalized) text the mention was scanned from. */
  start: number;
  end: number;
}

const MONTH_WORDS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Find every named period in a normalized question ("jan 2026",
 * "february", "q1 2026", "2026", "2026-01"). Mentions are returned
 * in the order they appear; overlapping scans are resolved longest
 * first so the year in "jan 2026" is not also reported as a
 * standalone year. Day/week periods cannot be named ("week 3" is a
 * count, not a date), so only month, quarter and year are matched.
 */
export function findPeriodMentions(text: string): PeriodMention[] {
  const mentions: PeriodMention[] = [];
  const taken: boolean[] = new Array(text.length).fill(false);
  const claim = (start: number, end: number): boolean => {
    for (let i = start; i < end; i++) if (taken[i]) return false;
    for (let i = start; i < end; i++) taken[i] = true;
    return true;
  };

  // ISO month first ("2026-01") so its year is not re-read below.
  const iso = /\b(\d{4})-(\d{2})\b/g;
  for (const m of text.matchAll(iso)) {
    const month = Number(m[2]);
    if (month < 1 || month > 12 || m.index === undefined) continue;
    const year = Number(m[1]);
    if (!claim(m.index, m.index + m[0].length)) continue;
    mentions.push({
      spec: {
        bucket: "month",
        key: `${year}-${pad2(month)}`,
        label: `${MONTH_NAMES[month - 1]} ${year}`,
        year,
      },
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Quarters ("q1 2026", "q3").
  const quarter = /\bq([1-4])(?:\s+(\d{4}))?\b/g;
  for (const m of text.matchAll(quarter)) {
    if (m.index === undefined) continue;
    if (!claim(m.index, m.index + m[0].length)) continue;
    const q = Number(m[1]);
    const year = m[2] ? Number(m[2]) : undefined;
    mentions.push({
      spec: {
        bucket: "quarter",
        key: year === undefined ? `Q${q}` : `${year}-Q${q}`,
        label: year === undefined ? `Q${q}` : `Q${q} ${year}`,
        year,
      },
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Months ("jan 2026", "february", "may").
  const monthNames = Object.keys(MONTH_WORDS).sort((a, b) => b.length - a.length).join("|");
  const month = new RegExp(`\\b(${monthNames})(?:\\s+(\\d{4}))?\\b`, "g");
  for (const m of text.matchAll(month)) {
    if (m.index === undefined) continue;
    if (!claim(m.index, m.index + m[0].length)) continue;
    const monthNum = MONTH_WORDS[m[1]];
    const year = m[2] ? Number(m[2]) : undefined;
    mentions.push({
      spec: {
        bucket: "month",
        key: year === undefined ? `M${monthNum}` : `${year}-${pad2(monthNum)}`,
        label: year === undefined ? MONTH_NAMES[monthNum - 1] : `${MONTH_NAMES[monthNum - 1]} ${year}`,
        year,
      },
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Bare years ("2026") — only where nothing else claimed the span.
  const yearRe = /\b(19|20)\d{2}\b/g;
  for (const m of text.matchAll(yearRe)) {
    if (m.index === undefined) continue;
    if (!claim(m.index, m.index + m[0].length)) continue;
    const year = Number(m[0]);
    mentions.push({
      spec: { bucket: "year", key: `${year}`, label: `${year}`, year },
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  return mentions.sort((a, b) => a.start - b.start);
}

/**
 * Fill in a period's missing year from the years actually present in
 * a date column. A period that already names a year is returned as
 * is; one without a year resolves to the sheet's only year, and
 * abstains (null + reason) when the sheet spans several years.
 */
export function resolvePeriodYear(
  spec: PeriodSpec,
  years: number[],
): { spec: PeriodSpec; error?: string } {
  if (spec.year !== undefined) return { spec };
  const distinct = [...new Set(years)].sort((a, b) => a - b);
  if (distinct.length === 0) {
    return { spec, error: `no dates in the sheet to place "${spec.label}" in a year` };
  }
  if (distinct.length > 1) {
    return {
      spec,
      error: `"${spec.label}" appears in more than one year (${distinct.join(", ")}) — say which year, e.g. "${spec.label} ${distinct[0]}"`,
    };
  }
  const year = distinct[0];
  if (spec.bucket === "month") {
    const month = Number(spec.key.slice(1));
    return {
      spec: {
        bucket: "month",
        key: `${year}-${pad2(month)}`,
        label: `${MONTH_NAMES[month - 1]} ${year}`,
        year,
      },
    };
  }
  const q = Number(spec.key.slice(1));
  return {
    spec: {
      bucket: "quarter",
      key: `${year}-Q${q}`,
      label: `Q${q} ${year}`,
      year,
    },
  };
}
