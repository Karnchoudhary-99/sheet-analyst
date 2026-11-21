/**
 * Tests for question explanation: the parsed query is described
 * faithfully for every query kind, and abstentions carry the reason
 * plus the columns available.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import {
  describeQuery,
  explainQuestion,
  formatExplainText,
} from "../src/explain.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sales = parseCsv(
  readFileSync(join(root, "examples", "sales.csv"), "utf8"),
);

describe("explainQuestion", () => {
  it("parses an aggregate with its operation and column", () => {
    const result = explainQuestion("total revenue", sales);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query).toEqual({
        kind: "aggregate",
        column: "revenue",
        op: "sum",
        filters: [],
      });
    }
  });

  it("parses a grouped query with filters", () => {
    const result = explainQuestion(
      "total revenue by region where region is North",
      sales,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query).toEqual({
        kind: "group",
        groupBy: ["region"],
        column: "revenue",
        op: "sum",
        filters: [{ column: "region", op: "=", value: "North" }],
        bucket: undefined,
      });
    }
  });

  it("parses a top-N query with its limit and direction", () => {
    const result = explainQuestion("top 3 products by revenue", sales);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query.kind).toBe("top");
      if (result.query.kind === "top") {
        expect(result.query.limit).toBe(3);
        expect(result.query.direction).toBe("highest");
        expect(result.query.column).toBe("revenue");
        expect(result.query.groupBy).toEqual(["product"]);
      }
    }
  });

  it("parses a time-bucketed group query", () => {
    const result = explainQuestion("total revenue by month", sales);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query).toEqual({
        kind: "group",
        groupBy: ["date"],
        column: "revenue",
        op: "sum",
        filters: [],
        bucket: "month",
      });
    }
  });

  it("abstains on an unknown column, naming the reason", () => {
    const result = explainQuestion("total profit", sales);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no column named/);
    }
  });
});

describe("describeQuery", () => {
  it("summarizes an aggregate in plain English", () => {
    expect(
      describeQuery({ kind: "aggregate", column: "revenue", op: "mean", filters: [] }),
    ).toEqual([
      "average of revenue",
      "operation: mean",
      "column: revenue",
      "filters: none",
    ]);
  });

  it("names the bucket on a time-grouped query", () => {
    const lines = describeQuery({
      kind: "group",
      groupBy: ["date"],
      column: "revenue",
      op: "sum",
      filters: [],
      bucket: "month",
    });
    expect(lines[0]).toBe("total of revenue, grouped by date, bucketed by month");
    expect(lines).toContain("time bucket: month");
  });

  it("says bottom for a lowest-direction ranking", () => {
    const lines = describeQuery({
      kind: "top",
      column: "revenue",
      limit: 3,
      direction: "lowest",
      groupBy: ["product"],
      filters: [],
    });
    expect(lines[0]).toBe("bottom 3 by revenue, grouped by product");
    expect(lines).toContain("limit: 3 (lowest)");
  });

  it("still says top for a highest-direction ranking", () => {
    const lines = describeQuery({
      kind: "top",
      column: "revenue",
      limit: 3,
      direction: "highest",
      groupBy: ["product"],
      filters: [],
    });
    expect(lines[0]).toBe("top 3 by revenue, grouped by product");
    expect(lines).toContain("limit: 3 (highest)");
  });

  it("names every group column on a multi-column group query", () => {
    const lines = describeQuery({
      kind: "group",
      groupBy: ["region", "product"],
      column: "revenue",
      op: "sum",
      filters: [],
    });
    expect(lines[0]).toBe("total of revenue, grouped by region and product");
    expect(lines).toContain("group by: region, product");
  });

  it("lists filters on a rows query", () => {
    const lines = describeQuery({
      kind: "rows",
      filters: [{ column: "region", op: "=", value: "North" }],
      limit: 10,
    });
    expect(lines).toContain("filters: region = North");
    expect(lines).toContain("limit: 10");
  });

  it("names the sort on a sorted rows query", () => {
    const lines = describeQuery({
      kind: "rows",
      filters: [],
      limit: 10,
      sort: { column: "revenue", direction: "desc" },
    });
    expect(lines[0]).toBe("matching rows (first 10), sorted by revenue (descending)");
    expect(lines).toContain("sorted by: revenue (descending)");
  });

  it("describes an above/below-average question", () => {
    const lines = describeQuery({
      kind: "aboveBelow",
      column: "revenue",
      direction: "above",
      baseline: "average",
      filters: [],
    });
    expect(lines[0]).toBe("rows with revenue above the average");
    expect(lines).toContain("operation: above average");
    expect(lines).toContain("baseline: average");
  });

  it("names both columns of a correlation", () => {
    expect(
      describeQuery({
        kind: "correlation",
        columnA: "revenue",
        columnB: "units",
        filters: [],
      }),
    ).toEqual([
      "correlation between revenue and units",
      "operation: correlation",
      "column A: revenue",
      "column B: units",
      "filters: none",
    ]);
  });
});

describe("formatExplainText", () => {
  it("renders the question, summary and details", () => {
    const staff = parseCsv(
      readFileSync(join(root, "examples", "employees.csv"), "utf8"),
    );
    const result = explainQuestion("average salary", staff);
    const text = formatExplainText("average salary", result, staff);
    expect(text).toContain('Question: "average salary"');
    expect(text).toContain("Understood as: average of salary");
    expect(text).toContain("operation: mean");
    expect(text).toContain("filters: none");
  });

  it("renders an abstention with the reason, without repeating the columns", () => {
    const result = explainQuestion("total profit", sales);
    const text = formatExplainText("total profit", result, sales);
    expect(text).toContain("I could not understand this question");
    expect(text).toContain("columns are: date, region, product, units, revenue.");
    expect(text).not.toContain("Columns available:");
  });

  it("lists the columns when the reason does not name them", () => {
    const result = explainQuestion("total revenue by decade", sales);
    const text = formatExplainText("total revenue by decade", result, sales);
    expect(text).toContain("I can't group by decade");
    expect(text).toContain("Columns available: date, region, product, units, revenue.");
  });
});

describe("describeQuery comparison", () => {
  it("describes both periods, the column and the operation", () => {
    const monthly = parseCsv(
      "date,region,product,units,revenue\n" +
        "2026-01-05,North,Widget A,10,200.00\n" +
        "2026-02-03,North,Widget B,12,299.88\n",
    );
    const explained = explainQuestion("compare revenue Jan 2026 vs Feb 2026", monthly);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "compare total of revenue: Jan 2026 vs Feb 2026",
      "operation: sum",
      "column: revenue",
      "date column: date",
      "period A: Jan 2026",
      "period B: Feb 2026",
      "filters: none",
    ]);
  });
});

describe("describeQuery share", () => {
  it("describes a value share with its column and filter", () => {
    const sales = parseCsv(
      "date,region,product,units,revenue\n" +
        "2026-01-05,North,Widget A,12,240.00\n" +
        "2026-01-06,South,Widget B,8,199.92\n",
    );
    const explained = explainQuestion("what share of revenue is North", sales);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "share of total revenue for region = North",
      "operation: share",
      "column: revenue",
      "filters: region = North",
    ]);
  });

  it("describes a row-count share without a column line", () => {
    const sales = parseCsv(
      "date,region,product,units,revenue\n" +
        "2026-01-05,North,Widget A,12,240.00\n" +
        "2026-01-06,South,Widget B,8,199.92\n",
    );
    const explained = explainQuestion("what share of rows are in North", sales);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "share of rows for region = North",
      "operation: share",
      "filters: region = North",
    ]);
  });
});

describe("describeQuery distinct values", () => {
  it("describes the column, limit and filters", () => {
    const sales = parseCsv(
      "date,region,product,units,revenue\n" +
        "2026-01-05,North,Widget A,12,240.00\n" +
        "2026-01-06,South,Widget B,8,199.92\n",
    );
    const explained = explainQuestion("list unique products in North", sales);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "distinct values of product",
      "operation: list distinct values",
      "column: product",
      "limit: 20",
      "filters: region = North",
    ]);
  });
});

describe("describeQuery mode and distinct count", () => {
  it("describes a mode question", () => {
    const sales = parseCsv(
      "date,region,product,units,revenue\n2026-01-05,North,Widget A,12,240.00\n",
    );
    const explained = explainQuestion("most common region", sales);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "most common value of region",
      "operation: mode",
      "column: region",
      "filters: none",
    ]);
  });

  it("describes a distinct-count question", () => {
    const sales = parseCsv(
      "date,region,product,units,revenue\n2026-01-05,North,Widget A,12,240.00\n",
    );
    const explained = explainQuestion("how many distinct regions", sales);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "distinct count of region",
      "operation: count distinct values",
      "column: region",
      "filters: none",
    ]);
  });
});

describe("describeQuery percentile", () => {
  it("describes the percentile, column and filters", () => {
    const sales = parseCsv(
      "date,region,product,units,revenue\n2026-01-05,North,Widget A,12,240.00\n",
    );
    const explained = explainQuestion("90th percentile of revenue in North", sales);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "90th percentile of revenue",
      "operation: percentile",
      "column: revenue",
      "percentile: 90",
      "filters: region = North",
    ]);
  });

  it("uses the ordinal label for the 25th percentile", () => {
    const sales = parseCsv(
      "date,region,product,units,revenue\n2026-01-05,North,Widget A,12,240.00\n",
    );
    const explained = explainQuestion("25th percentile of revenue", sales);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)[0]).toBe("25th percentile of revenue");
  });
});

describe("describeQuery trend", () => {
  it("describes the column, date column, bucket and filters", () => {
    const monthly = parseCsv(
      "date,region,revenue\n2026-01-05,North,240.00\n2026-02-03,South,400.00\n",
    );
    const explained = explainQuestion(
      "revenue trend by month where region is North",
      monthly,
    );
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)).toEqual([
      "trend of total revenue by month",
      "operation: trend",
      "column: revenue",
      "date column: date",
      "time bucket: month",
      "filters: region = North",
    ]);
  });

  it("names the average for an average trend", () => {
    const monthly = parseCsv(
      "date,revenue\n2026-01-05,240.00\n2026-02-03,400.00\n",
    );
    const explained = explainQuestion("average revenue trend by month", monthly);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(describeQuery(explained.query)[0]).toBe(
      "trend of average revenue by month",
    );
  });
});

describe("describeQuery missing values", () => {
  it("describes a single-column count", () => {
    const lines = describeQuery({
      kind: "missing",
      column: "salary",
      filters: [],
      listRows: false,
    });
    expect(lines[0]).toBe("missing values in salary");
    expect(lines).toContain("operation: missing values");
    expect(lines).toContain("column: salary");
  });

  it("describes a row listing", () => {
    const lines = describeQuery({
      kind: "missing",
      column: "salary",
      filters: [],
      listRows: true,
    });
    expect(lines[0]).toBe("rows missing salary");
    expect(lines).toContain("list rows: true");
  });

  it("describes a whole-sheet report with no column line", () => {
    const lines = describeQuery({
      kind: "missing",
      column: null,
      filters: [],
      listRows: false,
    });
    expect(lines[0]).toBe("missing values by column");
    expect(lines).toContain("operation: missing values");
    expect(lines).not.toContain("column: salary");
  });
});

describe("describeQuery outliers", () => {
  it("describes a single-column count", () => {
    const lines = describeQuery({
      kind: "outliers",
      column: "score",
      filters: [],
      listRows: false,
    });
    expect(lines[0]).toBe("outliers in score");
    expect(lines).toContain("operation: outliers");
    expect(lines).toContain("column: score");
  });

  it("describes a row listing", () => {
    const lines = describeQuery({
      kind: "outliers",
      column: "score",
      filters: [],
      listRows: true,
    });
    expect(lines[0]).toBe("rows that are outliers in score");
    expect(lines).toContain("list rows: true");
  });

  it("describes a whole-sheet report with no column line", () => {
    const lines = describeQuery({
      kind: "outliers",
      column: null,
      filters: [],
      listRows: false,
    });
    expect(lines[0]).toBe("outliers by column");
    expect(lines).toContain("operation: outliers");
    expect(lines).not.toContain("column: score");
  });
});

describe("describeQuery duplicates", () => {
  it("describes a single-column count", () => {
    const lines = describeQuery({
      kind: "duplicates",
      column: "product",
      duplicateRows: 3,
      entries: [{ column: "product", duplicates: 4, total: 7, valuesWithDuplicates: 2 }],
      headers: ["region", "product", "units"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 7,
    });
    expect(lines[0]).toBe("duplicates in product");
    expect(lines).toContain("operation: duplicates");
    expect(lines).toContain("column: product");
  });

  it("describes a row listing in one column", () => {
    const lines = describeQuery({
      kind: "duplicates",
      column: "product",
      duplicateRows: 3,
      entries: [{ column: "product", duplicates: 4, total: 7, valuesWithDuplicates: 2 }],
      headers: ["region", "product", "units"],
      rows: [],
      totalMatched: 4,
      listRows: true,
      rowsMatched: 7,
    });
    expect(lines[0]).toBe("rows that are duplicates in product");
    expect(lines).toContain("list rows: true");
  });

  it("describes an exact-duplicate-row listing with no column", () => {
    const lines = describeQuery({
      kind: "duplicates",
      column: null,
      duplicateRows: 3,
      entries: [],
      headers: ["region", "product", "units"],
      rows: [],
      totalMatched: 3,
      listRows: true,
      rowsMatched: 7,
    });
    expect(lines[0]).toBe("rows that duplicate an earlier row");
    expect(lines).toContain("operation: duplicates");
    expect(lines).not.toContain("column: product");
  });

  it("describes a whole-sheet report with no column line", () => {
    const lines = describeQuery({
      kind: "duplicates",
      column: null,
      duplicateRows: 3,
      entries: [],
      headers: ["region", "product", "units"],
      rows: [],
      totalMatched: 0,
      listRows: false,
      rowsMatched: 7,
    });
    expect(lines[0]).toBe("duplicates by column");
    expect(lines).toContain("operation: duplicates");
    expect(lines).not.toContain("column: product");
  });
});
