import { describe, expect, it } from "vitest";
import {
  histogram,
  renderBarChart,
  renderBarChartSvg,
  renderHistogram,
  renderResultChart,
  renderResultChartSvg,
  sparkline,
} from "../src/charts.js";

describe("renderBarChart", () => {
  it("scales bars to the largest value at full width", () => {
    const chart = renderBarChart(
      [
        { key: "North", value: 100 },
        { key: "South", value: 50 },
        { key: "East", value: 25 },
      ],
      { width: 10 },
    );
    const lines = chart.split("\n");
    expect(lines[0]).toBe("North ██████████ 100");
    expect(lines[1]).toBe("South █████ 50");
    // 25% of width 10 rounds to 3 blocks.
    expect(lines[2]).toBe("East  ███ 25");
  });

  it("aligns labels and prints every value", () => {
    const chart = renderBarChart([
      { key: "A", value: 10 },
      { key: "Long name", value: 10 },
    ]);
    const lines = chart.split("\n");
    expect(lines[0]!.indexOf("█")).toBe(lines[1]!.indexOf("█"));
    expect(lines[0]).toContain("10");
    expect(lines[1]).toContain("10");
  });

  it("renders a zero value as an empty bar, never hidden", () => {
    const chart = renderBarChart([
      { key: "North", value: 100 },
      { key: "South", value: 0 },
    ]);
    expect(chart.split("\n")[1]).toContain("South");
    expect(chart.split("\n")[1]).toContain("0");
    expect(chart.split("\n")[1]).not.toContain("█");
  });

  it("renders (no data) for an empty input", () => {
    expect(renderBarChart([])).toBe("(no data)");
  });

  it("renders an all-zero input without dividing by zero", () => {
    const chart = renderBarChart([
      { key: "A", value: 0 },
      { key: "B", value: 0 },
    ]);
    expect(chart).not.toContain("█");
    expect(chart).toContain("0");
  });
});

describe("histogram", () => {
  it("buckets values into equal-width bins", () => {
    const bins = histogram([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 5);
    expect(bins).toHaveLength(5);
    expect(bins.reduce((n, b) => n + b.count, 0)).toBe(11);
    // The maximum value lands in the last bin, never past the edge.
    expect(bins[4]!.count).toBe(3);
  });

  it("puts a flat series in a single bin", () => {
    const bins = histogram([5, 5, 5]);
    expect(bins).toHaveLength(1);
    expect(bins[0]!.count).toBe(3);
  });

  it("returns no bins for an empty series", () => {
    expect(histogram([])).toEqual([]);
  });
});

describe("renderHistogram", () => {
  it("labels bins with ranges and counts", () => {
    const out = renderHistogram(histogram([0, 50, 100], 2), { width: 4 });
    expect(out).toContain("0–50");
    expect(out).toContain("50–100");
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("sparkline", () => {
  it("rises with the series and starts at the lowest block", () => {
    expect(sparkline([0, 50, 100])).toBe("▁▅█");
    expect(sparkline([100, 50, 0])).toBe("█▅▁");
  });

  it("renders a flat series as mid-level blocks", () => {
    expect(sparkline([7, 7, 7])).toBe("▄▄▄");
  });

  it("renders (no data) for an empty series", () => {
    expect(sparkline([])).toBe("(no data)");
  });
});

describe("renderResultChart", () => {
  const groups = {
    kind: "groups" as const,
    groupBy: "region",
    column: "revenue",
    op: "sum",
    groups: [
      { key: "North", value: 100, count: 2 },
      { key: "South", value: 50, count: 1 },
    ],
    rowsMatched: 3,
    totalGroups: 2,
  };

  it("charts group results", () => {
    const chart = renderResultChart(groups);
    expect(chart).toContain("North");
    expect(chart).toContain("█");
  });

  it("returns null for scalar and row results", () => {
    expect(
      renderResultChart({
        kind: "scalar",
        label: "total revenue",
        value: 100,
        rowsMatched: 3,
        valuesUsed: 3,
      }),
    ).toBeNull();
    expect(
      renderResultChart({
        kind: "rows",
        headers: ["region"],
        rows: [{ region: "North" }],
        totalMatched: 1,
      }),
    ).toBeNull();
  });

  it("charts group results as SVG too", () => {
    const svg = renderResultChartSvg(groups, { title: "Revenue by region" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Revenue by region");
    expect(svg).toContain("North");
    expect(renderResultChartSvg({
      kind: "scalar",
      label: "total revenue",
      value: 100,
      rowsMatched: 3,
      valuesUsed: 3,
    })).toBeNull();
  });
});

describe("renderBarChartSvg", () => {
  it("escapes labels so a group name cannot break the document", () => {
    const svg = renderBarChartSvg([{ key: "<script>alert(1)</script>", value: 5 }]);
    expect(svg).not.toContain("<script>alert");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("scales bars to the largest value", () => {
    const svg = renderBarChartSvg([
      { key: "A", value: 100 },
      { key: "B", value: 50 },
    ]);
    const widths = [...svg.matchAll(/width="([\d.]+)"/g)].map((m) => Number(m[1]));
    // First rect width is the plot width; second is half of it.
    const rects = [...svg.matchAll(/<rect[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(rects[1]!).toBeCloseTo(rects[0]! / 2, 0);
    expect(widths.length).toBeGreaterThan(0);
  });
});
