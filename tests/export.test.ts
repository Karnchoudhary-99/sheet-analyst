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
