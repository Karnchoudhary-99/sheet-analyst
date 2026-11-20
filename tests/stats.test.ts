import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import {
  describe as describeSheet,
  leastSquaresSlope,
  numericStats,
  ordinal,
  pearsonCorrelation,
  percentile,
} from "../src/stats.js";

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

  it("reports quartiles by linear interpolation", () => {
    // Linear interpolation: Q1 rank 1.75 lands on 4, Q3 rank 5.25
    // lands a quarter of the way from 5 to 7.
    const s = numericStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.q1).toBe(4);
    expect(s.q3).toBe(5.5);
    // A single value has no spread: all quartiles equal it.
    const one = numericStats([7]);
    expect(one.q1).toBe(7);
    expect(one.q3).toBe(7);
  });
});

describe("percentile", () => {
  it("interpolates between ranks", () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([0, 10, 20, 30], 0.25)).toBe(7.5);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });

  it("throws on an empty array", () => {
    expect(() => percentile([], 0.5)).toThrow("empty array");
  });
});

describe("pearsonCorrelation", () => {
  it("is 1 for a perfect positive line, -1 for a perfect negative one", () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });

  it("is near 0 for unrelated series", () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [1, 4, 2, 3])).toBeCloseTo(0.4, 10);
  });

  it("returns null with fewer than two pairs", () => {
    expect(pearsonCorrelation([1], [2])).toBeNull();
    expect(pearsonCorrelation([], [])).toBeNull();
  });

  it("returns null for a constant series, not a misleading zero", () => {
    expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBeNull();
    expect(pearsonCorrelation([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("returns null on mismatched lengths", () => {
    expect(pearsonCorrelation([1, 2], [1])).toBeNull();
  });
});

describe("leastSquaresSlope", () => {
  it("recovers the slope of a perfect line, positive and negative", () => {
    expect(leastSquaresSlope([0, 1, 2], [10, 20, 30])).toBeCloseTo(10, 10);
    expect(leastSquaresSlope([0, 1, 2], [30, 20, 10])).toBeCloseTo(-10, 10);
  });

  it("is 0 for a flat series", () => {
    expect(leastSquaresSlope([0, 1, 2, 3], [5, 5, 5, 5])).toBeCloseTo(0, 10);
  });

  it("fits the monthly revenue slope from the sample data", () => {
    // Jan 664.91, Feb 914.81, Mar 834.81: mean 804.84…, the
    // covariance numerator is 169.9 over an x-variance of 2.
    expect(leastSquaresSlope([0, 1, 2], [664.91, 914.81, 834.81])).toBeCloseTo(
      84.95,
      10,
    );
  });

  it("returns null with fewer than two points", () => {
    expect(leastSquaresSlope([0], [7])).toBeNull();
    expect(leastSquaresSlope([], [])).toBeNull();
  });

  it("returns null when all xs are equal, not a misleading zero", () => {
    expect(leastSquaresSlope([2, 2, 2], [1, 2, 3])).toBeNull();
  });

  it("returns null on mismatched lengths", () => {
    expect(leastSquaresSlope([0, 1], [1])).toBeNull();
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

describe("ordinal", () => {
  it("uses 1st/2nd/3rd and th for the rest", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(90)).toBe("90th");
  });

  it("uses th for the teens, even for 11/12/13", () => {
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
  });
});
