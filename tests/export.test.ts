/**
 * Tests for result export: CSV tables per result kind, RFC 4180
 * escaping of commas/quotes/newlines, and .json/.csv detection.
 */
import { describe, expect, it } from "vitest";
import {
  abstentionToCsv,
  csvCell,
  exportFormat,
  resultToCsv,
} from "../src/export.js";
import type { QueryResult } from "../src/engine.js";

const groupsResult: QueryResult = {
  kind: "groups",
  groupBy: ["region"],
  column: "revenue",
  op: "sum",
  groups: [
    { key: "North", keys: ["North"], value: 1000.5, count: 3 },
    { key: "South", keys: ["South"], value: 789.1, count: 2 },
  ],
  rowsMatched: 5,
  totalGroups: 2,
};

const scalarResult: QueryResult = {
  kind: "scalar",
  label: "total revenue",
  value: 1789.6,
  rowsMatched: 5,
  valuesUsed: 5,
};

const rowsResult: QueryResult = {
  kind: "rows",
  headers: ["product", "region"],
  rows: [
    { product: "Widget A", region: "North" },
    { product: "Widget, B", region: 'South "HQ"' },
  ],
  totalMatched: 2,
};

describe("csvCell", () => {
  it("leaves plain values alone", () => {
    expect(csvCell("North")).toBe("North");
    expect(csvCell("240.00")).toBe("240.00");
  });

  it("quotes values with commas, quotes or newlines", () => {
    expect(csvCell("Widget, B")).toBe('"Widget, B"');
    expect(csvCell('South "HQ"')).toBe('"South ""HQ"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("resultToCsv", () => {
  it("writes groups as <group-by>,<column>,rows", () => {
    expect(resultToCsv(groupsResult, "total revenue by region", "")).toBe(
      "region,revenue,rows\nNorth,1000.5,3\nSouth,789.1,2",
    );
  });

  it("writes multi-column groups with one column per group-by column", () => {
    const multi: QueryResult = {
      kind: "groups",
      groupBy: ["region", "product"],
      column: "revenue",
      op: "sum",
      groups: [
        { key: "North · Widget A", keys: ["North", "Widget A"], value: 240, count: 2 },
        { key: "North · Widget, Deluxe", keys: ["North", "Widget, Deluxe"], value: 149.97, count: 1 },
      ],
      rowsMatched: 3,
      totalGroups: 2,
    };
    expect(resultToCsv(multi, "total revenue by region and product", "")).toBe(
      'region,product,revenue,rows\nNorth,Widget A,240,2\nNorth,"Widget, Deluxe",149.97,1',
    );
  });

  it("writes a scalar as one label/value row", () => {
    expect(resultToCsv(scalarResult, "total revenue", "")).toBe(
      "label,value,rows_matched,values_used\ntotal revenue,1789.6,5,5",
    );
  });

  it("leaves a null scalar value blank instead of zero", () => {
    const nullScalar: QueryResult = {
      kind: "scalar",
      label: "average age",
      value: null,
      rowsMatched: 3,
      valuesUsed: 0,
    };
    expect(resultToCsv(nullScalar, "average age", "")).toBe(
      "label,value,rows_matched,values_used\naverage age,,3,0",
    );
  });

  it("writes a rank as one label/value/rows-at-value row", () => {
    const rankResult: QueryResult = {
      kind: "rank",
      column: "salary",
      n: 2,
      direction: "highest",
      value: 95000,
      rowsAtValue: 1,
      totalDistinct: 4,
      rowsMatched: 5,
      valuesUsed: 4,
    };
    expect(resultToCsv(rankResult, "second highest salary", "")).toBe(
      "label,value,rows_at_value,distinct_values,rows_matched,values_used\n2nd highest salary,95000,1,4,5,4",
    );
  });

  it("leaves a past-the-end rank value blank instead of zero", () => {
    const rankResult: QueryResult = {
      kind: "rank",
      column: "salary",
      n: 5,
      direction: "highest",
      value: null,
      rowsAtValue: 0,
      totalDistinct: 4,
      rowsMatched: 5,
      valuesUsed: 4,
    };
    expect(resultToCsv(rankResult, "5th highest salary", "")).toBe(
      "label,value,rows_at_value,distinct_values,rows_matched,values_used\n5th highest salary,,0,4,5,4",
    );
  });

  it("writes a group rank with the holding group instead of a row count", () => {
    const groupRankResult: QueryResult = {
      kind: "rank",
      column: "revenue",
      n: 2,
      direction: "highest",
      groupBy: "region",
      op: "sum",
      groupsAtValue: ["North"],
      totalGroups: 4,
      value: 389.97,
      rowsAtValue: 3,
      totalDistinct: 4,
      rowsMatched: 6,
      valuesUsed: 6,
    };
    expect(resultToCsv(groupRankResult, "second highest total revenue by region", "")).toBe(
      "label,value,groups_at_value,distinct_values,rows_matched,values_used\n2nd highest total revenue by region,389.97,North,4,6,6",
    );
  });

  it("writes row results with their headers and escapes cells", () => {
    expect(resultToCsv(rowsResult, "show rows", "")).toBe(
      'product,region\nWidget A,North\n"Widget, B","South ""HQ"""',
    );
  });

  it("uses count as the value header for count groups", () => {
    const countGroups: QueryResult = {
      kind: "groups",
      groupBy: ["department"],
      column: null,
      op: "count",
      groups: [{ key: "Engineering", keys: ["Engineering"], value: 4, count: 4 }],
      rowsMatched: 4,
      totalGroups: 1,
    };
    expect(resultToCsv(countGroups, "how many employees by department", "")).toBe(
      "department,count,rows\nEngineering,4,4",
    );
  });

  it("writes a correlation as one column_a/column_b row", () => {
    const correlation: QueryResult = {
      kind: "correlation",
      columnA: "revenue",
      columnB: "units",
      value: 0.9015,
      pairs: 7,
      rowsMatched: 8,
    };
    expect(resultToCsv(correlation, "correlation between revenue and units", "")).toBe(
      "column_a,column_b,correlation,paired_rows,rows_matched\nrevenue,units,0.9015,7,8",
    );
  });

  it("leaves an uncomputable correlation blank instead of zero", () => {
    const correlation: QueryResult = {
      kind: "correlation",
      columnA: "a",
      columnB: "b",
      value: null,
      pairs: 1,
      rowsMatched: 4,
    };
    expect(resultToCsv(correlation, "correlation between a and b", "")).toBe(
      "column_a,column_b,correlation,paired_rows,rows_matched\na,b,,1,4",
    );
  });
});

describe("abstentionToCsv", () => {
  it("writes the question and the answer as one row", () => {
    expect(
      abstentionToCsv(
        "total profit",
        "I can't answer that from this data: no column named in the question — columns are: date, region, product, units, revenue.",
      ),
    ).toBe(
      'question,answer\ntotal profit,"I can\'t answer that from this data: no column named in the question — columns are: date, region, product, units, revenue."',
    );
  });
});

describe("exportFormat", () => {
  it("detects .json and .csv case-insensitively", () => {
    expect(exportFormat("out.json")).toBe("json");
    expect(exportFormat("OUT.CSV")).toBe("csv");
    expect(exportFormat("report.JSON")).toBe("json");
  });

  it("returns null for anything else", () => {
    expect(exportFormat("out.txt")).toBeNull();
    expect(exportFormat("out")).toBeNull();
    expect(exportFormat("out.csv.bak")).toBeNull();
  });
});

describe("resultToCsv comparison", () => {
  it("writes one row per period plus change and percent rows", () => {
    const result: QueryResult = {
      kind: "comparison",
      column: "revenue",
      op: "sum",
      dateColumn: "date",
      periodA: { label: "Jan 2026", value: 324.95, rows: 2, valuesUsed: 2 },
      periodB: { label: "Feb 2026", value: 419.88, rows: 2, valuesUsed: 2 },
      delta: 94.93,
      pctChange: 29.21,
      rowsMatched: 4,
    };
    expect(resultToCsv(result, "compare revenue Jan 2026 vs Feb 2026", "…")).toBe(
      "period,value,rows,values_used\n" +
        "Jan 2026,324.95,2,2\n" +
        "Feb 2026,419.88,2,2\n" +
        "change,94.93,,\n" +
        "percent_change,29.21,,",
    );
  });

  it("leaves value, change and percent blank when a period has no usable values", () => {
    const result: QueryResult = {
      kind: "comparison",
      column: "revenue",
      op: "sum",
      dateColumn: "date",
      periodA: { label: "Jan 2026", value: 324.95, rows: 2, valuesUsed: 2 },
      periodB: { label: "Feb 2026", value: null, rows: 0, valuesUsed: 0 },
      delta: null,
      pctChange: null,
      rowsMatched: 2,
    };
    expect(resultToCsv(result, "compare revenue Jan 2026 vs Feb 2026", "…")).toBe(
      "period,value,rows,values_used\n" +
        "Jan 2026,324.95,2,2\n" +
        "Feb 2026,,0,0\n" +
        "change,,,\n" +
        "percent_change,,,",
    );
  });
});

describe("resultToCsv head-to-head", () => {
  it("writes one row per side plus difference and percent-higher rows", () => {
    const result: QueryResult = {
      kind: "headtohead",
      column: "revenue",
      op: "sum",
      groupColumn: "region",
      sideA: { label: "North", value: 389.97, rows: 3, valuesUsed: 3 },
      sideB: { label: "South", value: 199.92, rows: 1, valuesUsed: 1 },
      difference: 190.05,
      pctHigher: 95.06,
      rowsMatched: 4,
    };
    expect(resultToCsv(result, "compare total revenue in North vs South", "…")).toBe(
      "side,value,rows,values_used\n" +
        "North,389.97,3,3\n" +
        "South,199.92,1,1\n" +
        "difference,190.05,,\n" +
        "percent_higher,95.06,,",
    );
  });

  it("leaves value, difference and percent blank when a side has no usable values", () => {
    const result: QueryResult = {
      kind: "headtohead",
      column: "revenue",
      op: "sum",
      groupColumn: "region",
      sideA: { label: "North", value: null, rows: 1, valuesUsed: 0 },
      sideB: { label: "South", value: 100, rows: 1, valuesUsed: 1 },
      difference: null,
      pctHigher: null,
      rowsMatched: 2,
    };
    expect(resultToCsv(result, "compare total revenue in North vs South", "…")).toBe(
      "side,value,rows,values_used\n" +
        "North,,1,0\n" +
        "South,100,1,1\n" +
        "difference,,,\n" +
        "percent_higher,,,",
    );
  });
});

describe("resultToCsv share", () => {
  it("writes the share as a fraction with subset and whole-sheet totals", () => {
    const result: QueryResult = {
      kind: "share",
      column: "revenue",
      filters: [{ column: "region", op: "=", value: "North" }],
      subsetValue: 389.97,
      totalValue: 1789.6,
      share: 389.97 / 1789.6,
      subsetRows: 3,
      totalRows: 8,
      valuesUsed: 3,
      totalValuesUsed: 8,
    };
    expect(resultToCsv(result, "what share of revenue is North", "…")).toBe(
      "label,share,subset_value,total_value,subset_rows,total_rows\n" +
        `total revenue,${389.97 / 1789.6},389.97,1789.6,3,8`,
    );
  });

  it("labels a row-count share 'rows' and leaves a zero-total share blank", () => {
    const result: QueryResult = {
      kind: "share",
      column: "b",
      filters: [{ column: "a", op: "=", value: "1" }],
      subsetValue: 0,
      totalValue: 0,
      share: null,
      subsetRows: 1,
      totalRows: 2,
      valuesUsed: 1,
      totalValuesUsed: 2,
    };
    expect(resultToCsv(result, "what share of b where a is 1", "…")).toBe(
      "label,share,subset_value,total_value,subset_rows,total_rows\n" +
        "total b,,0,0,1,2",
    );
  });
});

describe("resultToCsv distinct values", () => {
  it("writes one row per distinct value with its row count", () => {
    const result: QueryResult = {
      kind: "values",
      column: "region",
      values: [
        { value: "North", count: 3 },
        { value: "East", count: 1 },
      ],
      totalDistinct: 4,
      limitedTo: 2,
      rowsMatched: 6,
    };
    expect(resultToCsv(result, "list unique regions", "…")).toBe(
      "value,rows\nNorth,3\nEast,1",
    );
  });
});

describe("resultToCsv mode", () => {
  it("writes the modal value, its row count and the distinct total", () => {
    const result: QueryResult = {
      kind: "mode",
      column: "region",
      value: "North",
      count: 3,
      totalDistinct: 4,
      rowsMatched: 6,
      valuesUsed: 6,
    };
    expect(resultToCsv(result, "most common region", "…")).toBe(
      "column,value,rows,distinct_values,rows_matched\nregion,North,3,4,6",
    );
  });

  it("leaves the value blank when the mode could not be computed", () => {
    const result: QueryResult = {
      kind: "mode",
      column: "units",
      value: null,
      count: 0,
      totalDistinct: 0,
      rowsMatched: 0,
      valuesUsed: 0,
    };
    expect(resultToCsv(result, "most common units", "…")).toBe(
      "column,value,rows,distinct_values,rows_matched\nunits,,0,0,0",
    );
  });
});

describe("resultToCsv trend", () => {
  it("writes one row per period plus a slope row", () => {
    const result: QueryResult = {
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
    expect(resultToCsv(result, "revenue trend by month", "…")).toBe(
      "period,value,rows,values_used\n" +
        "Jan 2026,664.91,4,4\n" +
        "Feb 2026,914.81,4,4\n" +
        "Mar 2026,834.81,4,4\n" +
        "slope per month,84.95,,",
    );
  });

  it("leaves the period value and the slope blank when uncomputable", () => {
    const result: QueryResult = {
      kind: "trend",
      column: "revenue",
      op: "sum",
      dateColumn: "date",
      bucket: "month",
      periods: [{ label: "Jan 2026", value: null, rows: 1, valuesUsed: 0 }],
      slope: null,
      direction: null,
      rowsMatched: 1,
    };
    expect(resultToCsv(result, "revenue trend by month", "…")).toBe(
      "period,value,rows,values_used\nJan 2026,,1,0\nslope per month,,,",
    );
  });
});

describe("resultToCsv cumulative", () => {
  it("writes one row per period plus a total row", () => {
    const result: QueryResult = {
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
    expect(resultToCsv(result, "cumulative revenue by month", "…")).toBe(
      "period,value,cumulative,rows,values_used\n" +
        "Jan 2026,664.91,664.91,4,4\n" +
        "Feb 2026,914.81,1579.72,4,4\n" +
        "Mar 2026,834.81,2414.53,4,4\n" +
        "total,2414.53,,,",
    );
  });

  it("leaves the value blank for a valueless period and the total blank when uncomputable", () => {
    const result: QueryResult = {
      kind: "cumulative",
      column: "revenue",
      dateColumn: "date",
      bucket: "month",
      periods: [{ label: "Jan 2026", value: null, cumulative: null, rows: 1, valuesUsed: 0 }],
      total: null,
      rowsMatched: 1,
    };
    expect(resultToCsv(result, "cumulative revenue by month", "…")).toBe(
      "period,value,cumulative,rows,values_used\nJan 2026,,,1,0\ntotal,,,,",
    );
  });
});

describe("resultToCsv period change", () => {
  it("writes one row per period plus biggest-rise and biggest-fall rows", () => {
    const result: QueryResult = {
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
    expect(resultToCsv(result, "revenue change by month", "…")).toBe(
      "period,value,change,percent_change,rows,values_used\n" +
        "Jan 2026,664.91,,,4,4\n" +
        "Feb 2026,914.81,249.9,37.5849,4,4\n" +
        "Mar 2026,834.81,-80,-8.7444,4,4\n" +
        "biggest rise,Feb 2026,249.9,37.5849,,\n" +
        "biggest fall,Mar 2026,-80,-8.7444,,",
    );
  });

  it("leaves the percent blank off a zero baseline and omits a missing rise or fall", () => {
    const result: QueryResult = {
      kind: "periodchange",
      column: "revenue",
      op: "sum",
      dateColumn: "date",
      bucket: "month",
      periods: [
        { label: "Jan 2026", value: 0, change: null, pctChange: null, rows: 1, valuesUsed: 1 },
        { label: "Feb 2026", value: 500, change: 500, pctChange: null, rows: 1, valuesUsed: 1 },
      ],
      biggestRise: { label: "Feb 2026", change: 500, pctChange: null },
      biggestFall: null,
      rowsMatched: 2,
    };
    expect(resultToCsv(result, "revenue change by month", "…")).toBe(
      "period,value,change,percent_change,rows,values_used\n" +
        "Jan 2026,0,,,1,1\n" +
        "Feb 2026,500,500,,1,1\n" +
        "biggest rise,Feb 2026,500,,",
    );
  });
});

describe("resultToCsv above/below average", () => {
  it("writes the matching rows as a table", () => {
    const result: QueryResult = {
      kind: "aboveBelow",
      column: "revenue",
      direction: "above",
      baseline: "average",
      threshold: 185.81,
      headers: ["product", "revenue"],
      rows: [{ product: "Widget A", revenue: "400.00" }],
      totalMatched: 1,
      rowsMatched: 6,
    };
    expect(resultToCsv(result, "rows with revenue above average", "…")).toBe(
      "product,revenue\nWidget A,400.00",
    );
  });
});

describe("resultToCsv missing values", () => {
  it("writes one row per column with the missing fraction", () => {
    const result: QueryResult = {
      kind: "missing",
      column: null,
      entries: [
        { column: "units", missing: 1, total: 6 },
        { column: "revenue", missing: 0, total: 6 },
      ],
      headers: ["units", "revenue"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 6,
    };
    expect(resultToCsv(result, "which columns have missing values", "…")).toBe(
      "column,missing_rows,total_rows,percent_missing\n" +
        `units,1,6,${1 / 6}\n` +
        "revenue,0,6,0",
    );
  });

  it("writes just the one column for a single-column question", () => {
    const result: QueryResult = {
      kind: "missing",
      column: "units",
      entries: [{ column: "units", missing: 1, total: 6 }],
      headers: ["units"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 6,
    };
    expect(resultToCsv(result, "how many rows are missing units", "…")).toBe(
      "column,missing_rows,total_rows,percent_missing\n" + `units,1,6,${1 / 6}`,
    );
  });
});

describe("resultToCsv outliers", () => {
  it("writes one row per column with the outlier fraction and fence", () => {
    const result: QueryResult = {
      kind: "outliers",
      column: null,
      entries: [
        {
          column: "score",
          total: 8,
          outliers: 1,
          lowBound: 2.75,
          highBound: 20.75,
          low: 1000,
          high: 1000,
        },
        {
          column: "hours",
          total: 8,
          outliers: 0,
          lowBound: 2.5,
          highBound: 10.5,
          low: null,
          high: null,
        },
      ],
      headers: ["score", "hours"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 8,
    };
    expect(resultToCsv(result, "which columns have outliers", "…")).toBe(
      "column,outliers,total_rows,percent_outliers,low_bound,high_bound\n" +
        "score,1,8,0.125,2.75,20.75\n" +
        "hours,0,8,0,2.5,10.5",
    );
  });

  it("writes just the one column for a single-column question, with empty bounds when there is no fence", () => {
    const result: QueryResult = {
      kind: "outliers",
      column: "y",
      entries: [
        {
          column: "y",
          total: 3,
          outliers: 0,
          lowBound: null,
          highBound: null,
          low: null,
          high: null,
        },
      ],
      headers: ["y"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 3,
    };
    expect(resultToCsv(result, "how many outliers in y", "…")).toBe(
      "column,outliers,total_rows,percent_outliers,low_bound,high_bound\n" +
        "y,0,3,0,,",
    );
  });
});

describe("resultToCsv duplicates", () => {
  it("writes the full-row count first, then one row per column", () => {
    const result: QueryResult = {
      kind: "duplicates",
      column: null,
      duplicateRows: 3,
      entries: [
        { column: "product", duplicates: 4, total: 7, valuesWithDuplicates: 2 },
        { column: "region", duplicates: 3, total: 7, valuesWithDuplicates: 2 },
      ],
      headers: ["region", "product", "units"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 7,
    };
    expect(resultToCsv(result, "how many duplicate rows", "…")).toBe(
      "column,duplicate_rows,total_rows,percent_duplicates,values_with_duplicates\n" +
        "(full rows),3,7,0.42857142857142855,\n" +
        "product,4,7,0.5714285714285714,2\n" +
        "region,3,7,0.42857142857142855,2",
    );
  });

  it("writes just the one column for a single-column question", () => {
    const result: QueryResult = {
      kind: "duplicates",
      column: "product",
      duplicateRows: 3,
      entries: [{ column: "product", duplicates: 4, total: 7, valuesWithDuplicates: 2 }],
      headers: ["region", "product", "units"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 7,
    };
    expect(resultToCsv(result, "how many duplicate products", "…")).toBe(
      "column,duplicate_rows,total_rows,percent_duplicates,values_with_duplicates\n" +
        "product,4,7,0.5714285714285714,2",
    );
  });
});

describe("resultToCsv group extreme", () => {
  it("writes one row per group, best first, with values used", () => {
    const result: QueryResult = {
      kind: "groupextreme",
      groupBy: "region",
      column: "revenue",
      op: "sum",
      direction: "highest",
      winners: [{ key: "East", value: 400, count: 1 }],
      groups: [
        { key: "East", value: 400, count: 1, valuesUsed: 1 },
        { key: "North", value: 389.97, count: 3, valuesUsed: 3 },
        { key: "South", value: null, count: 1, valuesUsed: 0 },
      ],
      totalGroups: 3,
      rowsMatched: 5,
    };
    expect(resultToCsv(result, "which region has the highest total revenue", "…")).toBe(
      "region,revenue,rows,values_used\nEast,400,1,1\nNorth,389.97,3,3\nSouth,,1,0",
    );
  });
});
