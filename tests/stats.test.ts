import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import { describe as describeSheet, numericStats } from "../src/stats.js";

describe("numericStats", () => {
  it("computes mean, median and population stddev", () => {
    const s = numericStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBe(5);
    expect(s.median).toBe(4.5);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.sum).toBe(40);
    expect(s.stddev).toBeCloseTo(2, 5);
  });

  it("handles a single value", () => {
    const s = numericStats([7]);
    expect(s.mean).toBe(7);
    expect(s.median).toBe(7);
    expect(s.stddev).toBe(0);
  });
});

describe("describe", () => {
  it("summarizes numeric and text columns", () => {
    const parsed = parseCsv(
      "city,sales\nParis,10\nParis,20\nLyon,30\nLyon,\nMarseille,50",
    );
    const out = describeSheet(parsed);
    const sales = out.find((c) => c.name === "sales")!;
    expect(sales.stats.kind).toBe("numeric");
    if (sales.stats.kind === "numeric") {
      expect(sales.stats.count).toBe(4);
      expect(sales.stats.nullCount).toBe(1);
      expect(sales.stats.mean).toBe(27.5);
      expect(sales.stats.median).toBe(25);
    }
    const city = out.find((c) => c.name === "city")!;
    expect(city.stats.kind).toBe("categorical");
    if (city.stats.kind === "categorical") {
      expect(city.stats.distinctCount).toBe(3);
      expect(city.stats.top[0]).toEqual({ value: "Lyon", count: 2 });
      // Ties break alphabetically, so Lyon precedes Paris.
      expect(city.stats.top[1]).toEqual({ value: "Paris", count: 2 });
    }
  });

  it("summarizes date columns as epoch ranges", () => {
    const parsed = parseCsv("d\n2026-01-01\n2026-01-03");
    const out = describeSheet(parsed);
    const d = out[0].stats;
    expect(d.kind).toBe("numeric");
    if (d.kind === "numeric") {
      expect(d.min).toBe(Date.parse("2026-01-01"));
      expect(d.max).toBe(Date.parse("2026-01-03"));
      expect(d.count).toBe(2);
    }
  });
});
