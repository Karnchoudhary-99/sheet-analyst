import { describe, expect, it } from "vitest";
import {
  histogram,
  renderBarChart,
  renderBarChartSvg,
  renderHistogram,
  renderLineChart,
  renderLineChartSvg,
  renderResultChart,
  renderResultChartSvg,
  sparkline,
} from "../src/charts.js";
import type { QueryResult } from "../src/engine.js";

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
    groupBy: ["region"],
    column: "revenue",
    op: "sum",
    groups: [
      { key: "North", keys: ["North"], value: 100, count: 2 },
      { key: "South", keys: ["South"], value: 50, count: 1 },
    ],
    rowsMatched: 3,
    totalGroups: 2,
  };

  it("charts group results", () => {
    const chart = renderResultChart(groups);
    expect(chart).toContain("North");
    expect(chart).toContain("█");
  });

  it("charts multi-column groups under their composite labels", () => {
    const multi: QueryResult = {
      kind: "groups",
      groupBy: ["region", "product"],
      column: "revenue",
      op: "sum",
      groups: [
        { key: "North · Widget A", keys: ["North", "Widget A"], value: 240, count: 2 },
        { key: "East · Widget A", keys: ["East", "Widget A"], value: 400, count: 1 },
      ],
      rowsMatched: 3,
      totalGroups: 2,
    };
    const chart = renderResultChart(multi);
    expect(chart).toContain("North · Widget A");
    expect(chart).toContain("East · Widget A");
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

describe("renderLineChart", () => {
  const MONTHS = [
    { key: "Jan 2026", value: 439.92 },
    { key: "Feb 2026", value: 524.95 },
    { key: "Mar 2026", value: 674.76 },
  ];

  it("plots one dot per point in input order", () => {
    const chart = renderLineChart(MONTHS, { width: 12, height: 5 });
    expect(chart).toContain("●");
    expect(chart.match(/●/g)).toHaveLength(3);
    expect(chart).toContain("674.76"); // max labelled at the top
    expect(chart).toContain("439.92"); // min labelled at the bottom
    expect(chart).toContain("Jan 2026");
    expect(chart).toContain("Mar 2026");
  });

  it("draws a flat series as a horizontal line", () => {
    const chart = renderLineChart(
      [
        { key: "A", value: 10 },
        { key: "B", value: 10 },
        { key: "C", value: 10 },
      ],
      { width: 10, height: 5 },
    );
    expect(chart).toContain("─");
    expect(chart).not.toContain("╱");
    expect(chart).not.toContain("╲");
  });

  it("slopes up and down with the values", () => {
    const chart = renderLineChart(
      [
        { key: "A", value: 0 },
        { key: "B", value: 10 },
        { key: "C", value: 0 },
      ],
      { width: 10, height: 5 },
    );
    expect(chart).toContain("╱");
    expect(chart).toContain("╲");
  });

  it("renders a single point as one dot", () => {
    const chart = renderLineChart([{ key: "Jan 2026", value: 5 }], { width: 10, height: 5 });
    expect(chart.match(/●/g)).toHaveLength(1);
    expect(chart).toContain("Jan 2026");
  });

  it("renders an empty series as (no data)", () => {
    expect(renderLineChart([])).toBe("(no data)");
  });
});

describe("renderLineChartSvg", () => {
  it("draws a polyline with one circle per point", () => {
    const svg = renderLineChartSvg(
      [
        { key: "Jan 2026", value: 100 },
        { key: "Feb 2026", value: 200 },
      ],
      { title: "Revenue by month" },
    );
    expect(svg).toContain("<polyline");
    expect(svg.match(/<circle/g)).toHaveLength(2);
    expect(svg).toContain("Revenue by month");
    expect(svg).toContain("Jan 2026");
    expect(svg).toContain("Feb 2026");
  });

  it("escapes labels so a hostile key cannot break the document", () => {
    const svg = renderLineChartSvg([{ key: "<script>", value: 1 }]);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });
});

describe("renderResultChart time routing", () => {
  it("draws a line chart for bucketed groups, a bar chart otherwise", () => {
    const timeGroups: QueryResult = {
      kind: "groups",
      groupBy: ["date"],
      column: "revenue",
      op: "sum",
      groups: [
        { key: "Jan 2026", keys: ["Jan 2026"], value: 100, count: 2 },
        { key: "Feb 2026", keys: ["Feb 2026"], value: 200, count: 2 },
      ],
      rowsMatched: 4,
      bucket: "month",
    };
    const line = renderResultChart(timeGroups);
    expect(line).toContain("●");
    expect(line).not.toContain("█");
    expect(renderResultChartSvg(timeGroups)).toContain("<polyline");

    const plainGroups = { ...timeGroups, bucket: undefined };
    const bar = renderResultChart(plainGroups);
    expect(bar).toContain("█");
    expect(bar).not.toContain("●");
  });
});

describe("renderResultChart trend", () => {
  const trend: QueryResult = {
    kind: "trend",
    column: "revenue",
    op: "sum",
    dateColumn: "date",
    bucket: "month",
    periods: [
      { label: "Jan 2026", value: 664.91, rows: 4, valuesUsed: 4 },
      { label: "Feb 2026", value: 914.81, rows: 4, valuesUsed: 4 },
      { label: "Mar 2026", value: 834.81, rows: 4, valuesUsed: 4 },
    ],
    slope: 84.95,
    direction: "up",
    rowsMatched: 12,
  };

  it("draws a trend as a line chart over its periods", () => {
    const chart = renderResultChart(trend);
    // The line chart labels the first and last periods on the axis
    // and the min/max values on the side — the middle period is a
    // point on the line, not an axis label.
    expect(chart).toContain("Jan 2026");
    expect(chart).toContain("Mar 2026");
    expect(chart).toContain("914.81");
    expect(chart).toContain("664.91");
  });

  it("draws the SVG line chart too", () => {
    const svg = renderResultChartSvg(trend, { title: "Revenue trend" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Revenue trend");
  });

  it("leaves a period with no usable value out of the line, never as zero", () => {
    const gapped: QueryResult = {
      ...trend,
      periods: [
        { label: "Jan 2026", value: null, rows: 1, valuesUsed: 0 },
        { label: "Feb 2026", value: 914.81, rows: 4, valuesUsed: 4 },
        { label: "Mar 2026", value: 834.81, rows: 4, valuesUsed: 4 },
      ],
      slope: -80,
      direction: "down",
    };
    const chart = renderResultChart(gapped);
    expect(chart).not.toContain("Jan 2026");
    expect(chart).toContain("Feb 2026");
  });

  it("returns null when no period has a usable value", () => {
    const empty: QueryResult = {
      ...trend,
      periods: [{ label: "Jan 2026", value: null, rows: 1, valuesUsed: 0 }],
      slope: null,
      direction: null,
      rowsMatched: 1,
    };
    expect(renderResultChart(empty)).toBeNull();
    expect(renderResultChartSvg(empty)).toBeNull();
  });
});

describe("renderResultChart cumulative", () => {
  const running: QueryResult = {
    kind: "cumulative",
    column: "revenue",
    dateColumn: "date",
    bucket: "month",
    periods: [
      { label: "Jan 2026", value: 664.91, cumulative: 664.91, rows: 4, valuesUsed: 4 },
      { label: "Feb 2026", value: 914.81, cumulative: 1579.72, rows: 4, valuesUsed: 4 },
      { label: "Mar 2026", value: 834.81, cumulative: 2414.53, rows: 4, valuesUsed: 4 },
    ],
    total: 2414.53,
    rowsMatched: 12,
  };

  it("draws a running total as a line chart over its cumulative values", () => {
    const chart = renderResultChart(running);
    expect(chart).toContain("Jan 2026");
    expect(chart).toContain("Mar 2026");
    // The line runs over the running totals, not the period values.
    expect(chart).toContain("2,414.53");
    expect(chart).toContain("664.91");
  });

  it("draws the SVG line chart too", () => {
    const svg = renderResultChartSvg(running, { title: "Running total" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Running total");
  });

  it("leaves a period with no running total out of the line, never as zero", () => {
    const gapped: QueryResult = {
      ...running,
      periods: [
        { label: "Jan 2026", value: null, cumulative: null, rows: 1, valuesUsed: 0 },
        { label: "Feb 2026", value: 914.81, cumulative: 914.81, rows: 4, valuesUsed: 4 },
        { label: "Mar 2026", value: 834.81, cumulative: 1749.62, rows: 4, valuesUsed: 4 },
      ],
      total: 1749.62,
    };
    const chart = renderResultChart(gapped);
    expect(chart).not.toContain("Jan 2026");
    expect(chart).toContain("Feb 2026");
  });

  it("returns null when no period has a running total", () => {
    const empty: QueryResult = {
      ...running,
      periods: [{ label: "Jan 2026", value: null, cumulative: null, rows: 1, valuesUsed: 0 }],
      total: null,
      rowsMatched: 1,
    };
    expect(renderResultChart(empty)).toBeNull();
    expect(renderResultChartSvg(empty)).toBeNull();
  });
});

describe("renderResultChart period change", () => {
  const changing: QueryResult = {
    kind: "periodchange",
    column: "revenue",
    op: "sum",
    dateColumn: "date",
    bucket: "month",
    periods: [
      { label: "Jan 2026", value: 664.91, change: null, pctChange: null, rows: 4, valuesUsed: 4 },
      { label: "Feb 2026", value: 914.81, change: 249.9, pctChange: 37.5849, rows: 4, valuesUsed: 4 },
      { label: "Mar 2026", value: 834.81, change: -80, pctChange: -8.7444, rows: 4, valuesUsed: 4 },
    ],
    biggestRise: { label: "Feb 2026", change: 249.9, pctChange: 37.5849 },
    biggestFall: { label: "Mar 2026", change: -80, pctChange: -8.7444 },
    rowsMatched: 12,
  };

  it("draws a period change as a line chart over its changes", () => {
    const chart = renderResultChart(changing);
    expect(chart).toContain("Feb 2026");
    expect(chart).toContain("Mar 2026");
    // The line runs over the changes (+249.9, -80), not the levels.
    expect(chart).toContain("249.9");
    expect(chart).toContain("-80");
  });

  it("draws the SVG line chart too", () => {
    const svg = renderResultChartSvg(changing, { title: "Revenue change" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Revenue change");
  });

  it("leaves a period with no change out of the line, never as zero", () => {
    const chart = renderResultChart(changing);
    expect(chart).not.toContain("Jan 2026");
    expect(chart).toContain("Feb 2026");
  });

  it("returns null when no period has a change", () => {
    const empty: QueryResult = {
      ...changing,
      periods: [{ label: "Jan 2026", value: 664.91, change: null, pctChange: null, rows: 4, valuesUsed: 4 }],
      biggestRise: null,
      biggestFall: null,
      rowsMatched: 4,
    };
    expect(renderResultChart(empty)).toBeNull();
    expect(renderResultChartSvg(empty)).toBeNull();
  });
});

describe("renderResultChart group share", () => {
  const shared: QueryResult = {
    kind: "groupshare",
    groupBy: "region",
    column: "revenue",
    groups: [
      { key: "East", value: 400, share: 0.35879588102328586, count: 1, valuesUsed: 1 },
      { key: "North", value: 389.97, share: 0.349799074306627, count: 3, valuesUsed: 3 },
      { key: "South", value: 199.92, share: 0.17932618133543826, count: 1, valuesUsed: 1 },
      { key: "West", value: 124.95, share: 0.11207886333464893, count: 1, valuesUsed: 1 },
    ],
    total: 1114.84,
    rowsMatched: 6,
    valuesUsed: 6,
  };

  it("draws a group share as a bar chart labelled in percents", () => {
    const chart = renderResultChart(shared);
    expect(chart).toContain("East");
    expect(chart).toContain("North");
    // The bars are labelled with the share as a percent, not the raw total.
    expect(chart).toContain("35.88%");
    expect(chart).toContain("34.98%");
    expect(chart).not.toContain("1,114.84");
  });

  it("draws the SVG bar chart too", () => {
    const svg = renderResultChartSvg(shared, { title: "Revenue share" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Revenue share");
    expect(svg).toContain("35.88%");
  });

  it("leaves a group with no share out of the chart, never as zero", () => {
    const partial: QueryResult = {
      ...shared,
      groups: [
        { key: "North", value: 100, share: 1, count: 1, valuesUsed: 1 },
        { key: "South", value: null, share: null, count: 1, valuesUsed: 0 },
      ],
      total: 100,
      rowsMatched: 2,
      valuesUsed: 1,
    };
    const chart = renderResultChart(partial);
    expect(chart).toContain("North");
    expect(chart).not.toContain("South");
  });

  it("returns null when no group has a share", () => {
    const empty: QueryResult = {
      ...shared,
      groups: [{ key: "North", value: null, share: null, count: 1, valuesUsed: 0 }],
      total: null,
      rowsMatched: 1,
      valuesUsed: 0,
    };
    expect(renderResultChart(empty)).toBeNull();
    expect(renderResultChartSvg(empty)).toBeNull();
  });
});
