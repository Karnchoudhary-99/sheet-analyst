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
