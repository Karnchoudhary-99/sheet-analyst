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
  groupBy: "region",
  column: "revenue",
  op: "sum",
  groups: [
    { key: "North", value: 1000.5, count: 3 },
    { key: "South", value: 789.1, count: 2 },
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
      groupBy: "department",
      column: null,
      op: "count",
      groups: [{ key: "Engineering", value: 4, count: 4 }],
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
