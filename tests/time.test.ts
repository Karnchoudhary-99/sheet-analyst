import { describe, expect, it } from "vitest";
import { bucketDate, isoWeek, parseDate, type TimeBucket } from "../src/time.js";

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
