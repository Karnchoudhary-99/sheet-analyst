import { describe, expect, it } from "vitest";
import {
  bucketDate,
  findPeriodMentions,
  isoWeek,
  parseDate,
  resolvePeriodYear,
  type TimeBucket,
} from "../src/time.js";

describe("parseDate", () => {
  it("parses ISO dates", () => {
    expect(parseDate("2026-01-05")).toEqual({ year: 2026, month: 1, day: 5 });
  });

  it("parses ISO datetimes by their date part", () => {
    expect(parseDate("2026-03-01T10:30:00Z")).toEqual({ year: 2026, month: 3, day: 1 });
    expect(parseDate("2026-03-01 10:30")).toEqual({ year: 2026, month: 3, day: 1 });
  });

  it("parses day-first DD/MM/YYYY", () => {
    expect(parseDate("05/01/2026")).toEqual({ year: 2026, month: 1, day: 5 });
    expect(parseDate("5/1/2026")).toEqual({ year: 2026, month: 1, day: 5 });
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(parseDate("31/04/2026")).toBeNull();
  });

  it("rejects non-dates", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("North")).toBeNull();
    expect(parseDate("2026/01/05")).toBeNull();
  });

  it("accepts leap day in a leap year, rejects it otherwise", () => {
    expect(parseDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseDate("2026-02-29")).toBeNull();
  });
});

describe("isoWeek", () => {
  it("gives week 1 to the week with the year's first Thursday", () => {
    // 2026-01-01 is a Thursday: week 1. 2025-12-29 is the Monday of
    // that same week, so it is 2026-W01, not 2025-W53.
    expect(isoWeek({ year: 2026, month: 1, day: 1 })).toBe(1);
    expect(isoWeek({ year: 2025, month: 12, day: 29 })).toBe(1);
    expect(isoWeek({ year: 2026, month: 12, day: 28 })).toBe(53);
  });
});

describe("bucketDate", () => {
  const buckets: TimeBucket[] = ["day", "week", "month", "quarter", "year"];
  it("returns null for a value that is not a date", () => {
    for (const b of buckets) expect(bucketDate("not a date", b)).toBeNull();
  });

  it("buckets a day as itself", () => {
    expect(bucketDate("2026-01-05", "day")).toEqual({
      key: "2026-01-05",
      label: "2026-01-05",
    });
  });

  it("buckets by ISO week, keyed on the week-year", () => {
    // 2025-12-29 (Monday) belongs to 2026-W01.
    expect(bucketDate("2025-12-29", "week")).toEqual({
      key: "2026-W01",
      label: "2026-W01",
    });
    expect(bucketDate("2026-01-05", "week")).toEqual({
      key: "2026-W02",
      label: "2026-W02",
    });
  });

  it("buckets by month with a human label", () => {
    expect(bucketDate("2026-01-05", "month")).toEqual({
      key: "2026-01",
      label: "Jan 2026",
    });
    expect(bucketDate("05/03/2026", "month")).toEqual({
      key: "2026-03",
      label: "Mar 2026",
    });
  });

  it("buckets by quarter", () => {
    expect(bucketDate("2026-01-05", "quarter")).toEqual({
      key: "2026-Q1",
      label: "Q1 2026",
    });
    expect(bucketDate("2026-11-19", "quarter")).toEqual({
      key: "2026-Q4",
      label: "Q4 2026",
    });
  });

  it("buckets by year", () => {
    expect(bucketDate("2026-01-05", "year")).toEqual({ key: "2026", label: "2026" });
  });

  it("keys sort chronologically", () => {
    const keys = ["2026-03-01", "2026-01-05", "2026-02-10"]
      .map((d) => bucketDate(d, "month")!.key)
      .sort();
    expect(keys).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

describe("findPeriodMentions", () => {
  it("finds two months with years, in order", () => {
    const mentions = findPeriodMentions("compare revenue jan 2026 vs feb 2026");
    expect(mentions.map((m) => m.spec.key)).toEqual(["2026-01", "2026-02"]);
    expect(mentions.map((m) => m.spec.label)).toEqual(["Jan 2026", "Feb 2026"]);
  });

  it("finds a bare month name and leaves the year unresolved", () => {
    const [m] = findPeriodMentions("revenue change from january to february");
    expect(m.spec.bucket).toBe("month");
    expect(m.spec.year).toBeUndefined();
    expect(m.spec.label).toBe("Jan");
  });

  it("finds quarters and bare years", () => {
    const mentions = findPeriodMentions("compare revenue q1 2026 vs q2 2026");
    expect(mentions.map((m) => m.spec.key)).toEqual(["2026-Q1", "2026-Q2"]);
    expect(findPeriodMentions("compare revenue 2025 vs 2026").map((m) => m.spec.key)).toEqual([
      "2025",
      "2026",
    ]);
  });

  it("reads an ISO month without double-counting its year", () => {
    const mentions = findPeriodMentions("compare revenue 2026-01 vs 2026-02");
    expect(mentions).toHaveLength(2);
    expect(mentions.map((m) => m.spec.key)).toEqual(["2026-01", "2026-02"]);
  });

  it("finds no period in a plain question", () => {
    expect(findPeriodMentions("total revenue by region")).toEqual([]);
  });
});

describe("resolvePeriodYear", () => {
  it("keeps a period that already names a year", () => {
    const [m] = findPeriodMentions("jan 2026");
    expect(resolvePeriodYear(m.spec, [2025, 2026]).spec.key).toBe("2026-01");
  });

  it("resolves a bare month to the sheet's only year", () => {
    const [m] = findPeriodMentions("february");
    const { spec, error } = resolvePeriodYear(m.spec, [2026]);
    expect(error).toBeUndefined();
    expect(spec.key).toBe("2026-02");
    expect(spec.label).toBe("Feb 2026");
  });

  it("resolves a bare quarter to the sheet's only year", () => {
    const [m] = findPeriodMentions("q3");
    const { spec, error } = resolvePeriodYear(m.spec, [2026]);
    expect(error).toBeUndefined();
    expect(spec.key).toBe("2026-Q3");
  });

  it("refuses to guess when the sheet spans several years", () => {
    const [m] = findPeriodMentions("january");
    const { error } = resolvePeriodYear(m.spec, [2025, 2026]);
    expect(error).toMatch(/more than one year/);
  });

  it("refuses when the sheet has no dates at all", () => {
    const [m] = findPeriodMentions("january");
    expect(resolvePeriodYear(m.spec, []).error).toMatch(/no dates/);
  });
});
