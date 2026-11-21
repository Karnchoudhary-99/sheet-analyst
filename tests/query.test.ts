import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import { parseQuestion } from "../src/query.js";

const SALES = parseCsv(
  "date,region,product,units,revenue\n" +
    "2026-01-05,North,Widget A,12,240.00\n" +
    "2026-01-06,South,Widget B,8,199.92\n" +
    "2026-01-07,North,Widget C,3,149.97\n",
);

const STAFF = parseCsv(
  "id,name,department,salary,start_date,remote\n" +
    "1,Ada,Engineering,95000,2024-03-01,true\n" +
    "2,Grace,Engineering,98000,2023-07-15,true\n" +
    "3,Alan,Data,88000,2025-01-20,false\n",
);

// A sheet with both "date" and "start date" columns: "by start date"
// must resolve to the one column, not to "start date" plus "date".
const DATES = parseCsv(
  "date,start_date,region,revenue\n" +
    "2026-01-05,2024-03-01,North,240.00\n" +
    "2026-01-06,2023-07-15,South,199.92\n",
);

describe("parseQuestion aggregates", () => {
  it("parses a total", () => {
    const r = parseQuestion("total revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: { kind: "aggregate", column: "revenue", op: "sum", filters: [] },
    });
  });

  it("parses an average with a multi-word column", () => {
    const r = parseQuestion("average salary", STAFF);
    expect(r).toEqual({
      ok: true,
      query: { kind: "aggregate", column: "salary", op: "mean", filters: [] },
    });
  });

  it("parses a median and tolerates case and underscores", () => {
    const r = parseQuestion("What is the MEDIAN start_date?", STAFF);
    expect(r).toEqual({
      ok: true,
      query: { kind: "aggregate", column: "start_date", op: "median", filters: [] },
    });
  });
});

describe("parseQuestion counts", () => {
  it("counts all rows", () => {
    expect(parseQuestion("how many rows", SALES)).toEqual({
      ok: true,
      query: { kind: "count", filters: [] },
    });
  });

  it("counts with a bare-value filter", () => {
    const r = parseQuestion("how many employees in Engineering", STAFF);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "count",
        filters: [{ column: "department", op: "=", value: "Engineering" }],
      },
    });
  });

  it("counts per group", () => {
    const r = parseQuestion("how many employees by department", STAFF);
    expect(r).toEqual({
      ok: true,
      query: { kind: "group", groupBy: ["department"], column: null, op: "count", filters: [] },
    });
  });
});

describe("parseQuestion group-by", () => {
  it("groups a total by a column", () => {
    const r = parseQuestion("total revenue by region", SALES);
    expect(r).toEqual({
      ok: true,
      query: { kind: "group", groupBy: ["region"], column: "revenue", op: "sum", filters: [] },
    });
  });

  it("accepts 'per' as the group marker", () => {
    const r = parseQuestion("average salary per department", STAFF);
    expect(r).toEqual({
      ok: true,
      query: { kind: "group", groupBy: ["department"], column: "salary", op: "mean", filters: [] },
    });
  });
});

describe("parseQuestion multi-column group-by", () => {
  it("groups by two columns joined with 'and'", () => {
    const r = parseQuestion("total revenue by region and product", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "group",
        groupBy: ["region", "product"],
        column: "revenue",
        op: "sum",
        filters: [],
      },
    });
  });

  it("keeps the order the columns were named in", () => {
    const r = parseQuestion("total revenue by product and region", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") {
      expect(r.query.groupBy).toEqual(["product", "region"]);
    }
  });

  it("accepts a comma-separated group list", () => {
    const r = parseQuestion("total revenue by region, product", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") {
      expect(r.query.groupBy).toEqual(["region", "product"]);
    }
  });

  it("counts per two-column group", () => {
    const r = parseQuestion("how many employees by department and remote", STAFF);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "group",
        groupBy: ["department", "remote"],
        column: null,
        op: "count",
        filters: [],
      },
    });
  });

  it("groups by three columns", () => {
    const r = parseQuestion("total revenue by date and region and product", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") {
      expect(r.query.groupBy).toEqual(["date", "region", "product"]);
    }
  });

  it("abstains on more than three group columns", () => {
    const r = parseQuestion(
      "total revenue by date and region and product and units",
      SALES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/at most three columns/);
  });

  it("abstains when a word after 'and' is not a column, instead of dropping it", () => {
    const r = parseQuestion("total revenue by region and profit", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not find a column named "profit"/);
  });

  it("abstains on a time bucket combined with a second group column", () => {
    const r = parseQuestion("total revenue by region and product by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one dimension at a time/);
  });

  it("abstains on 'by month and region' instead of silently dropping the region", () => {
    const r = parseQuestion("total revenue by month and region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one dimension at a time/);
  });

  it("treats a multi-word column name as one group, not two", () => {
    const r = parseQuestion("total salary by start date", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") {
      expect(r.query.groupBy).toEqual(["start_date"]);
    }
  });

  it("does not split a multi-word name when a shorter column also matches", () => {
    const r = parseQuestion("total revenue by start date", DATES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") {
      expect(r.query.groupBy).toEqual(["start_date"]);
    }
  });
});

describe("parseQuestion top-N", () => {
  it("ranks groups by the column after 'by'", () => {
    const r = parseQuestion("top 3 products by revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "top",
        column: "revenue",
        limit: 3,
        direction: "highest",
        groupBy: ["product"],
        filters: [],
      },
    });
  });

  it("ranks rows when no group column is named", () => {
    const r = parseQuestion("top 5 revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "top",
        column: "revenue",
        limit: 5,
        direction: "highest",
        groupBy: undefined,
        filters: [],
      },
    });
  });

  it("treats a bare superlative as top 1", () => {
    const r = parseQuestion("highest revenue", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "top") {
      expect(r.query.limit).toBe(1);
      expect(r.query.direction).toBe("highest");
      expect(r.query.column).toBe("revenue");
    }
  });

  it("treats 'lowest' as the bottom direction", () => {
    const r = parseQuestion("lowest 2 salary", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "top") {
      expect(r.query.limit).toBe(2);
      expect(r.query.direction).toBe("lowest");
      expect(r.query.column).toBe("salary");
    }
  });

  it("treats 'bottom N' as the lowest direction", () => {
    const r = parseQuestion("bottom 3 products by revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "top",
        column: "revenue",
        limit: 3,
        direction: "lowest",
        groupBy: ["product"],
        filters: [],
        bucket: undefined,
      },
    });
  });

  it("treats a bare 'bottom' as bottom 1", () => {
    const r = parseQuestion("bottom revenue", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "top") {
      expect(r.query.limit).toBe(1);
      expect(r.query.direction).toBe("lowest");
      expect(r.query.column).toBe("revenue");
    }
  });

  it("ranks periods ascending for 'bottom N months'", () => {
    const r = parseQuestion("bottom 2 months by revenue", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "top") {
      expect(r.query.limit).toBe(2);
      expect(r.query.direction).toBe("lowest");
      expect(r.query.groupBy).toEqual(["date"]);
      expect(r.query.bucket).toBe("month");
    }
  });

  it("keeps 'least' as the minimum aggregate, not a ranking", () => {
    // "least revenue" is the minimum scalar — the word "least" is
    // an aggregate word, not a ranking word, so it must not become
    // a top-N rows result.
    const r = parseQuestion("least revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: { kind: "aggregate", column: "revenue", op: "min", filters: [] },
    });
  });
});

describe("parseQuestion filters", () => {
  it("parses a where-equality filter", () => {
    const r = parseQuestion("total revenue where region is North", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "aggregate",
        column: "revenue",
        op: "sum",
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("parses a where-comparison filter", () => {
    const r = parseQuestion("average salary where salary > 90000", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([{ column: "salary", op: ">", value: "90000" }]);
    }
  });

  it("resolves 'in <value>' to the owning column", () => {
    const r = parseQuestion("total revenue in North", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([{ column: "region", op: "=", value: "North" }]);
    }
  });

  it("returns matching rows for a filtered question with no aggregate", () => {
    const r = parseQuestion("rows where region is North", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "rows",
        filters: [{ column: "region", op: "=", value: "North" }],
        limit: 10,
      },
    });
  });

  it("returns matching rows for 'show' questions", () => {
    const r = parseQuestion("show rows where department is Data", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query.kind).toBe("rows");
  });

  it("parses a between-range filter as two inclusive bounds", () => {
    const r = parseQuestion("total revenue where revenue between 100 and 200", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "revenue", op: ">=", value: "100" },
        { column: "revenue", op: "<=", value: "200" },
      ]);
    }
  });

  it("parses a between-range filter over dates", () => {
    const r = parseQuestion(
      "how many rows where date between 2026-01-06 and 2026-01-08",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "count") {
      expect(r.query.filters).toEqual([
        { column: "date", op: ">=", value: "2026-01-06" },
        { column: "date", op: "<=", value: "2026-01-08" },
      ]);
    }
  });

  it("abstains on a reversed between-range instead of answering 'no rows'", () => {
    const r = parseQuestion("total revenue where revenue between 200 and 100", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/smaller value first/);
  });
});

describe("parseQuestion compound filters", () => {
  it("parses two equality conditions joined by and", () => {
    const r = parseQuestion(
      "total revenue where region is North and product is Widget A",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "region", op: "=", value: "North" },
        { column: "product", op: "=", value: "Widget A" },
      ]);
    }
  });

  it("parses mixed operators across conditions", () => {
    const r = parseQuestion(
      "average salary where salary > 90000 and department is Engineering",
      STAFF,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "salary", op: ">", value: "90000" },
        { column: "department", op: "=", value: "Engineering" },
      ]);
    }
  });

  it("parses two conditions on the same column", () => {
    const r = parseQuestion(
      "how many rows where revenue > 100 and revenue < 200",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "count") {
      expect(r.query.filters).toEqual([
        { column: "revenue", op: ">", value: "100" },
        { column: "revenue", op: "<", value: "200" },
      ]);
    }
  });

  it("parses three conditions", () => {
    const r = parseQuestion(
      "how many rows where region is North and product is Widget A and units > 10",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "count") {
      expect(r.query.filters).toEqual([
        { column: "region", op: "=", value: "North" },
        { column: "product", op: "=", value: "Widget A" },
        { column: "units", op: ">", value: "10" },
      ]);
    }
  });

  it("keeps a between-range's own and when a second condition follows", () => {
    const r = parseQuestion(
      "total revenue where revenue between 100 and 200 and region is North",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "revenue", op: ">=", value: "100" },
        { column: "revenue", op: "<=", value: "200" },
        { column: "region", op: "=", value: "North" },
      ]);
    }
  });

  it("keeps a between-range over dates when a second condition follows", () => {
    const r = parseQuestion(
      "how many rows where date between 2026-01-05 and 2026-01-06 and region is North",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "count") {
      expect(r.query.filters).toEqual([
        { column: "date", op: ">=", value: "2026-01-05" },
        { column: "date", op: "<=", value: "2026-01-06" },
        { column: "region", op: "=", value: "North" },
      ]);
    }
  });

  it("parses an is-not condition alongside an equality condition", () => {
    const r = parseQuestion(
      "how many rows where region is not South and product is Widget B",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "count") {
      expect(r.query.filters).toEqual([
        { column: "region", op: "!=", value: "South" },
        { column: "product", op: "=", value: "Widget B" },
      ]);
    }
  });

  it("carries compound filters into a rows question", () => {
    const r = parseQuestion(
      "show rows where region is North and product is Widget A",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "rows") {
      expect(r.query.filters).toEqual([
        { column: "region", op: "=", value: "North" },
        { column: "product", op: "=", value: "Widget A" },
      ]);
    }
  });

  it("carries compound filters into a group-by question", () => {
    const r = parseQuestion(
      "total revenue by region where product is Widget A and units > 10",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") {
      expect(r.query.groupBy).toEqual(["region"]);
      expect(r.query.filters).toEqual([
        { column: "product", op: "=", value: "Widget A" },
        { column: "units", op: ">", value: "10" },
      ]);
    }
  });

  it("does not split an and inside a quoted value", () => {
    const r = parseQuestion(
      'total revenue where product is "Widget A and B"',
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "product", op: "=", value: "Widget A and B" },
      ]);
    }
  });

  it("reads an unquoted value containing and as one filter", () => {
    const r = parseQuestion(
      "total revenue where product is Salt and Pepper",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "product", op: "=", value: "Salt and Pepper" },
      ]);
    }
  });

  it("abstains naming the unknown column in the second condition", () => {
    const r = parseQuestion(
      "total revenue where region is North and frobnicate is X",
      SALES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/frobnicate is X/);
  });

  it("abstains on a reversed between-range inside a compound", () => {
    const r = parseQuestion(
      "total revenue where revenue between 200 and 100 and region is North",
      SALES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/smaller value first/);
  });
});

describe("parseQuestion or filters", () => {
  it("parses a bare value as the same column's second branch", () => {
    const r = parseQuestion("total revenue where region is North or South", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([]);
      expect(r.query.orGroups).toEqual([
        [{ column: "region", op: "=", value: "North" }],
        [{ column: "region", op: "=", value: "South" }],
      ]);
    }
  });

  it("parses two full conditions joined by or", () => {
    const r = parseQuestion(
      "how many rows where revenue > 400 or revenue < 130",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "count") {
      expect(r.query.orGroups).toEqual([
        [{ column: "revenue", op: ">", value: "400" }],
        [{ column: "revenue", op: "<", value: "130" }],
      ]);
    }
  });

  it("parses or across two columns", () => {
    const r = parseQuestion(
      "total revenue where region is North or product is Widget C",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.orGroups).toEqual([
        [{ column: "region", op: "=", value: "North" }],
        [{ column: "product", op: "=", value: "Widget C" }],
      ]);
    }
  });

  it("parses three branches", () => {
    const r = parseQuestion(
      "total revenue where region is North or South or East",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.orGroups).toEqual([
        [{ column: "region", op: "=", value: "North" }],
        [{ column: "region", op: "=", value: "South" }],
        [{ column: "region", op: "=", value: "East" }],
      ]);
    }
  });

  it("binds and tighter than or", () => {
    // "a and b or c" is (a and b) or c: the second branch inherits
    // the region from the first, then adds its own product filter.
    const r = parseQuestion(
      "total revenue where region is North or South and product is Widget A",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.orGroups).toEqual([
        [{ column: "region", op: "=", value: "North" }],
        [
          { column: "region", op: "=", value: "South" },
          { column: "product", op: "=", value: "Widget A" },
        ],
      ]);
    }
  });

  it("keeps a between-range's own and inside an or branch", () => {
    const r = parseQuestion(
      "how many rows where revenue between 100 and 200 or revenue > 400",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "count") {
      expect(r.query.orGroups).toEqual([
        [
          { column: "revenue", op: ">=", value: "100" },
          { column: "revenue", op: "<=", value: "200" },
        ],
        [{ column: "revenue", op: ">", value: "400" }],
      ]);
    }
  });

  it("does not split an or inside a quoted value", () => {
    const r = parseQuestion(
      'total revenue where product is "Salt or Pepper"',
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "product", op: "=", value: "Salt or Pepper" },
      ]);
      expect(r.query.orGroups).toBeUndefined();
    }
  });

  it("reads an unquoted or between two values as two branches", () => {
    // Unlike "and" (which may sit inside a value), an unquoted
    // "or" between two values is two alternatives — a single
    // product literally named "Salt or Pepper" needs quotes.
    const r = parseQuestion("total revenue where product is Salt or Pepper", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([]);
      expect(r.query.orGroups).toEqual([
        [{ column: "product", op: "=", value: "Salt" }],
        [{ column: "product", op: "=", value: "Pepper" }],
      ]);
    }
  });

  it("abstains naming the unknown column in an or branch", () => {
    const r = parseQuestion(
      "total revenue where region is North or profit is 10",
      SALES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/profit is 10/);
  });

  it("abstains on a bare value with nothing to inherit from", () => {
    const r = parseQuestion("total revenue where South or region is North", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not tell what "South" means/);
  });

  it("abstains when a bare value follows a non-equality filter", () => {
    // "200" cannot inherit from "revenue > 100" — the operator is
    // not "=", so the question is ambiguous.
    const r = parseQuestion("total revenue where revenue > 100 or 200", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not tell what "200" means/);
  });

  it("refuses a column phrase with stray words instead of dropping them", () => {
    const r = parseQuestion(
      "total revenue where South and product is Widget A",
      SALES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/is not part of a column name/);
  });

  it("still parses 'is greater than' with the verb in the phrase", () => {
    const r = parseQuestion("total revenue where revenue is greater than 100", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([{ column: "revenue", op: ">", value: "100" }]);
    }
  });
});

describe("parseQuestion excluding filters", () => {
  it("parses excluding as a not-equal filter", () => {
    const r = parseQuestion("total revenue excluding North", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([{ column: "region", op: "!=", value: "North" }]);
    }
  });

  it("parses except as the same filter", () => {
    const r = parseQuestion("total revenue except Widget A", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "product", op: "!=", value: "Widget A" },
      ]);
    }
  });

  it("parses several excluded values as several filters", () => {
    const r = parseQuestion("total revenue excluding North and South", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "region", op: "!=", value: "North" },
        { column: "region", op: "!=", value: "South" },
      ]);
    }
  });

  it("composes with an in filter", () => {
    const r = parseQuestion("total revenue for North excluding South", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "region", op: "!=", value: "South" },
        { column: "region", op: "=", value: "North" },
      ]);
    }
  });

  it("works placed before a where clause with or", () => {
    const r = parseQuestion(
      "total revenue excluding Widget C where region is North or South",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "product", op: "!=", value: "Widget C" },
      ]);
      expect(r.query.orGroups).toEqual([
        [{ column: "region", op: "=", value: "North" }],
        [{ column: "region", op: "=", value: "South" }],
      ]);
    }
  });

  it("abstains on an unknown excluded value", () => {
    const r = parseQuestion("total revenue excluding Frobnicate", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not find "Frobnicate"/);
  });

  it("refuses excluding inside a where clause", () => {
    const r = parseQuestion(
      "total revenue where region is North or South excluding East",
      SALES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/inside a where clause/);
  });

  it("does not treat excluding inside a quoted value as an exclusion", () => {
    const r = parseQuestion(
      'total revenue where product is "Salt excluding Pepper"',
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aggregate") {
      expect(r.query.filters).toEqual([
        { column: "product", op: "=", value: "Salt excluding Pepper" },
      ]);
    }
  });
});

describe("parseQuestion distribution", () => {
  it("parses a distribution question", () => {
    const r = parseQuestion("distribution of salary", STAFF);
    expect(r).toEqual({
      ok: true,
      query: { kind: "distribution", column: "salary", filters: [] },
    });
  });

  it("parses histogram as a distribution question", () => {
    const r = parseQuestion("histogram of revenue", SALES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query.kind).toBe("distribution");
  });

  it("parses a show-me distribution question", () => {
    const r = parseQuestion("show distribution of salary", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "distribution") {
      expect(r.query.column).toBe("salary");
    }
  });

  it("carries filters into a distribution question", () => {
    const r = parseQuestion("distribution of revenue where region is North", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "distribution") {
      expect(r.query.filters).toEqual([{ column: "region", op: "=", value: "North" }]);
    }
  });

  it("resolves a trailing in-value filter for a distribution", () => {
    const r = parseQuestion("distribution of salary in Engineering", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "distribution") {
      expect(r.query.filters).toEqual([
        { column: "department", op: "=", value: "Engineering" },
      ]);
    }
  });

  it("abstains on a text column", () => {
    const r = parseQuestion("distribution of region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a numeric column/);
  });

  it("abstains on an unknown column", () => {
    const r = parseQuestion("distribution of profit", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a time-bucketed distribution", () => {
    const r = parseQuestion("distribution of salary by month", STAFF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/time period/);
  });
});

describe("parseQuestion sorted rows", () => {
  it("parses 'sorted by' with an explicit descending direction", () => {
    const r = parseQuestion("show rows sorted by revenue descending", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "rows",
        filters: [],
        limit: 10,
        sort: { column: "revenue", direction: "desc" },
      },
    });
  });

  it("defaults to ascending when no direction is named", () => {
    const r = parseQuestion("list employees sorted by salary", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "rows") {
      expect(r.query.sort).toEqual({ column: "salary", direction: "asc" });
    }
  });

  it("routes a bare 'rows sorted by' question to the row listing", () => {
    const r = parseQuestion("rows sorted by date", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "rows") {
      expect(r.query.sort).toEqual({ column: "date", direction: "asc" });
    }
  });

  it("keeps filters alongside the sort", () => {
    const r = parseQuestion(
      "show rows where region is North sorted by revenue descending",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "rows") {
      expect(r.query.filters).toEqual([{ column: "region", op: "=", value: "North" }]);
      expect(r.query.sort).toEqual({ column: "revenue", direction: "desc" });
    }
  });

  it("abstains on an unknown sort column instead of listing unsorted", () => {
    const r = parseQuestion("show rows sorted by profit descending", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not find a column to sort by/);
  });

  it("abstains when a sort phrase is put on an aggregate", () => {
    const r = parseQuestion("total revenue sorted by region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/sorting applies to row listings/);
  });
});

describe("parseQuestion above/below average", () => {
  it("parses 'above average' with the column after the marker", () => {
    const r = parseQuestion("above average revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "aboveBelow",
        column: "revenue",
        direction: "above",
        baseline: "average",
        filters: [],
      },
    });
  });

  it("parses the column before the marker", () => {
    const r = parseQuestion("rows with revenue above average", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aboveBelow") {
      expect(r.query.column).toBe("revenue");
      expect(r.query.direction).toBe("above");
      expect(r.query.baseline).toBe("average");
    }
  });

  it("prefers the after-side column over the row noun", () => {
    const r = parseQuestion("which products are above average revenue", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aboveBelow") {
      expect(r.query.column).toBe("revenue");
    }
  });

  it("reads 'below the median' and 'lower than average'", () => {
    const median = parseQuestion("which employees have salary below the median", STAFF);
    expect(median.ok).toBe(true);
    if (median.ok && median.query.kind === "aboveBelow") {
      expect(median.query).toEqual({
        kind: "aboveBelow",
        column: "salary",
        direction: "below",
        baseline: "median",
        filters: [],
      });
    }
    const lower = parseQuestion("salary lower than average", STAFF);
    expect(lower.ok).toBe(true);
    if (lower.ok && lower.query.kind === "aboveBelow") {
      expect(lower.query.direction).toBe("below");
      expect(lower.query.baseline).toBe("average");
    }
  });

  it("keeps filters alongside the comparison", () => {
    const r = parseQuestion("rows with revenue above average where region is North", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "aboveBelow") {
      expect(r.query.filters).toEqual([{ column: "region", op: "=", value: "North" }]);
    }
  });

  it("abstains on an unknown column", () => {
    const r = parseQuestion("above average profit", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a non-numeric column", () => {
    const r = parseQuestion("above average region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a numeric column/);
  });

  it("abstains on a grouped comparison instead of answering whole-sheet", () => {
    const r = parseQuestion("above average revenue by region", SALES);
    expect(r.ok).toBe(false);
  });
});

describe("parseQuestion time grouping", () => {
  it("groups a total by month using the sheet's only date column", () => {
    const r = parseQuestion("total revenue by month", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "group",
        groupBy: ["date"],
        column: "revenue",
        op: "sum",
        filters: [],
        bucket: "month",
      },
    });
  });

  it("accepts 'per year' and period aliases", () => {
    const r = parseQuestion("average salary per year", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.kind).toBe("group");
      if (r.query.kind === "group") {
        expect(r.query.groupBy).toEqual(["start_date"]);
        expect(r.query.bucket).toBe("year");
      }
    }
    const monthly = parseQuestion("total revenue by monthly", SALES);
    expect(monthly.ok).toBe(true);
    if (monthly.ok && monthly.query.kind === "group") {
      expect(monthly.query.bucket).toBe("month");
    }
  });

  it("accepts an explicit date column with a period", () => {
    const r = parseQuestion("total salary by start date by month", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") {
      expect(r.query.groupBy).toEqual(["start_date"]);
      expect(r.query.bucket).toBe("month");
    }
  });

  it("counts rows by month", () => {
    const r = parseQuestion("how many rows by month", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "group",
        groupBy: ["date"],
        column: null,
        op: "count",
        filters: [],
        bucket: "month",
      },
    });
  });

  it("abstains on an unsupported period instead of answering the plain total", () => {
    const r = parseQuestion("total revenue by decade", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't group by decade/);
  });

  it("abstains when the named group-by column is not a date", () => {
    const r = parseQuestion("total revenue by region by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a date column/);
  });

  it("abstains when the sheet has no date column", () => {
    const noDates = parseCsv("region,revenue\nNorth,100\nSouth,200\n");
    const r = parseQuestion("total revenue by month", noDates);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no date column/);
  });

  it("abstains when several date columns could be meant", () => {
    const twoDates = parseCsv(
      "start_date,end_date,revenue\n2026-01-05,2026-01-06,100\n2026-02-05,2026-02-06,200\n",
    );
    const r = parseQuestion("total revenue by month", twoDates);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/which date column/);
  });

  it("abstains on two periods in one question", () => {
    const r = parseQuestion("total revenue by month by year", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one period at a time/);
  });

  it("ranks periods for a bare period word in top-N", () => {
    const r = parseQuestion("top 2 months by revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "top",
        column: "revenue",
        limit: 2,
        direction: "highest",
        groupBy: ["date"],
        filters: [],
        bucket: "month",
      },
    });
  });

  it("ranks two-column groups", () => {
    const r = parseQuestion("top 3 region and product by revenue", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "top",
        column: "revenue",
        limit: 3,
        direction: "highest",
        groupBy: ["region", "product"],
        filters: [],
      },
    });
  });

  it("abstains on a top-N over two groups plus a time bucket", () => {
    const r = parseQuestion("top 3 region and product by revenue by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one dimension at a time/);
  });

  it("abstains on ranking more than three columns", () => {
    const r = parseQuestion(
      "top 3 date and region and product and units by revenue",
      SALES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/at most three columns/);
  });

  it("leaves plain group-by questions untouched", () => {
    const r = parseQuestion("total revenue by region", SALES);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "group") expect(r.query.bucket).toBeUndefined();
  });
});

describe("parseQuestion abstention", () => {
  it("abstains on an empty question", () => {
    const r = parseQuestion("   ", SALES);
    expect(r.ok).toBe(false);
  });

  it("abstains when no operation word is present", () => {
    const r = parseQuestion("what is the capital of France", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/totals, averages/);
  });

  it("abstains when the column does not exist", () => {
    const r = parseQuestion("total profit", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on an ambiguous column", () => {
    const tricky = parseCsv("city,city_code,sales\nParis,75,10\nLyon,69,20\n");
    const r = parseQuestion("average city code", tricky);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not tell which column/);
  });

  it("abstains when a bare value belongs to several columns", () => {
    const dup = parseCsv("home,work\nParis,Paris\nLyon,Paris\n");
    const r = parseQuestion("how many rows in Paris", dup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/several columns/);
  });

  it("abstains on an unparseable where clause", () => {
    const r = parseQuestion("total revenue where region frobnicate North", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not understand the filter/);
  });
});

describe("parseQuestion correlation", () => {
  it("parses 'correlation between X and Y'", () => {
    const r = parseQuestion("correlation between revenue and units", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "correlation",
        columnA: "revenue",
        columnB: "units",
        filters: [],
      },
    });
  });

  it("parses 'how correlated are X and Y'", () => {
    const r = parseQuestion("how correlated are salary and id", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "correlation") {
      expect(new Set([r.query.columnA, r.query.columnB])).toEqual(
        new Set(["salary", "id"]),
      );
    }
  });

  it("keeps filters on a correlation question", () => {
    const r = parseQuestion(
      "correlation between revenue and units where region is North",
      SALES,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "correlation") {
      expect(r.query.filters).toEqual([
        { column: "region", op: "=", value: "North" },
      ]);
    }
  });

  it("abstains when fewer than two columns are named", () => {
    const r = parseQuestion("correlation between revenue", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs two columns/);
  });

  it("abstains when a column is not numeric", () => {
    const r = parseQuestion("correlation between revenue and region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/two numeric columns/);
  });

  it("abstains when a named column does not exist", () => {
    const r = parseQuestion("correlation between revenue and profit", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs two columns/);
  });

  it("abstains on a time-grouped correlation", () => {
    const r = parseQuestion("correlation between revenue and units by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });
});

describe("parseQuestion period comparison", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,10,200.00\n" +
      "2026-01-12,South,Widget B,5,124.95\n" +
      "2026-02-03,North,Widget B,12,299.88\n" +
      "2026-02-10,South,Widget A,6,120.00\n",
  );
  const TWOYEAR = parseCsv(
    "date,product,revenue\n" +
      "2025-01-05,Widget A,100\n" +
      "2026-01-05,Widget A,200\n",
  );
  const NODATE = parseCsv(
    "product,units,revenue\n" + "Widget A,10,200.00\n" + "Widget B,5,124.95\n",
  );

  it("parses a two-month comparison, defaulting to the total", () => {
    const r = parseQuestion("compare revenue Jan 2026 vs Feb 2026", MONTHLY);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "comparison",
        column: "revenue",
        op: "sum",
        dateColumn: "date",
        periodA: { bucket: "month", key: "2026-01", label: "Jan 2026", year: 2026 },
        periodB: { bucket: "month", key: "2026-02", label: "Feb 2026", year: 2026 },
        filters: [],
      },
    });
  });

  it("parses 'change from X to Y' and resolves bare months to the sheet's only year", () => {
    const r = parseQuestion("revenue change from January to February", MONTHLY);
    expect(r.ok).toBe(true);
    if (r.ok && r.query.kind === "comparison") {
      expect(r.query.periodA.key).toBe("2026-01");
      expect(r.query.periodB.key).toBe("2026-02");
      expect(r.query.op).toBe("sum");
    }
  });

  it("parses an average comparison and a quarter comparison", () => {
    const avg = parseQuestion("compare average revenue Jan 2026 vs Feb 2026", MONTHLY);
    expect(avg.ok).toBe(true);
    if (avg.ok && avg.query.kind === "comparison") expect(avg.query.op).toBe("mean");
    const q = parseQuestion("compare revenue Q1 2026 vs Q2 2026", MONTHLY);
    expect(q.ok).toBe(true);
    if (q.ok && q.query.kind === "comparison") {
      expect(q.query.periodA).toEqual({ bucket: "quarter", key: "2026-Q1", label: "Q1 2026", year: 2026 });
    }
  });

  it("parses a row-count comparison", () => {
    const r = parseQuestion("compare rows in Jan vs Feb", MONTHLY);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "comparison",
        column: null,
        op: "count",
        dateColumn: "date",
        periodA: { bucket: "month", key: "2026-01", label: "Jan 2026", year: 2026 },
        periodB: { bucket: "month", key: "2026-02", label: "Feb 2026", year: 2026 },
        filters: [],
      },
    });
  });

  it("abstains when only one period is named", () => {
    const r = parseQuestion("compare revenue Jan 2026", MONTHLY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/two periods/);
  });

  it("abstains when both periods are the same", () => {
    const r = parseQuestion("compare revenue Jan 2026 vs Jan 2026", MONTHLY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/both periods are/);
  });

  it("abstains when the periods are different kinds", () => {
    const r = parseQuestion("compare revenue Jan 2026 vs 2026", MONTHLY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/like with like/);
  });

  it("abstains when the sheet has no date column", () => {
    const r = parseQuestion("compare revenue Jan 2026 vs Feb 2026", NODATE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a date column/);
  });

  it("abstains when the compared column is not numeric", () => {
    const r = parseQuestion("compare region Jan 2026 vs Feb 2026", MONTHLY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/numeric column/);
  });

  it("abstains on a bare month when the sheet spans several years", () => {
    const r = parseQuestion("revenue change from January to February", TWOYEAR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/more than one year/);
  });

  it("does not treat a plain question as a comparison", () => {
    const r = parseQuestion("total revenue", MONTHLY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query.kind).toBe("aggregate");
  });
});

describe("parseQuestion share", () => {
  it("parses 'what share of revenue is North'", () => {
    const r = parseQuestion("what share of revenue is North", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "share",
        column: "revenue",
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("parses 'what share of revenues is North' — plural column names work", () => {
    const r = parseQuestion("what share of revenues is North", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "share",
        column: "revenue",
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("parses 'what percentage of total revenue comes from North'", () => {
    const r = parseQuestion(
      "what percentage of total revenue comes from North",
      SALES,
    );
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "share",
        column: "revenue",
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("parses a row-count share", () => {
    const r = parseQuestion("what share of rows are in North", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "share",
        column: null,
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("keeps a where filter on a share question", () => {
    const r = parseQuestion("what share of revenue where region is North", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "share",
        column: "revenue",
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("resolves a multi-word value to its column", () => {
    const r = parseQuestion("what share of revenue is Widget A", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "share",
        column: "revenue",
        filters: [{ column: "product", op: "=", value: "Widget A" }],
      },
    });
  });

  it("abstains when no group is named", () => {
    const r = parseQuestion("what share of revenue", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a group/);
  });

  it("abstains on a share of an average", () => {
    const r = parseQuestion("what share of average revenue is North", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/compare totals/);
  });

  it("abstains when the named column does not exist", () => {
    const r = parseQuestion("what share of profit is North", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains when the column is not numeric", () => {
    const r = parseQuestion("what share of region is North", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/numeric column/);
  });

  it("abstains when the value belongs to no column", () => {
    const r = parseQuestion("what share of revenue is Atlantis", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not find "atlantis"/);
  });

  it("abstains on a time-grouped share", () => {
    const r = parseQuestion("what share of revenue is North by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });
});

describe("parseQuestion distinct values", () => {
  it("parses 'list unique regions'", () => {
    const r = parseQuestion("list unique regions", SALES);
    expect(r).toEqual({
      ok: true,
      query: { kind: "distinct", column: "region", filters: [], limit: 20 },
    });
  });

  it("parses 'what are the distinct products'", () => {
    const r = parseQuestion("what are the distinct products", SALES);
    expect(r).toEqual({
      ok: true,
      query: { kind: "distinct", column: "product", filters: [], limit: 20 },
    });
  });

  it("keeps a filter on a distinct-values question", () => {
    const r = parseQuestion("list unique products in North", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "distinct",
        column: "product",
        filters: [{ column: "region", op: "=", value: "North" }],
        limit: 20,
      },
    });
  });

  it("abstains when no column is named", () => {
    const r = parseQuestion("list unique values", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains when the named column does not exist", () => {
    const r = parseQuestion("list unique profits", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a time-grouped distinct question", () => {
    const r = parseQuestion("list unique regions by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });
});

describe("parseQuestion mode", () => {
  it("parses 'most common region'", () => {
    expect(parseQuestion("most common region", SALES)).toEqual({
      ok: true,
      query: { kind: "mode", column: "region", filters: [] },
    });
  });

  it("parses 'what is the mode of product'", () => {
    expect(parseQuestion("what is the mode of product", SALES)).toEqual({
      ok: true,
      query: { kind: "mode", column: "product", filters: [] },
    });
  });

  it("keeps a filter on a mode question", () => {
    expect(parseQuestion("most common product in North", SALES)).toEqual({
      ok: true,
      query: {
        kind: "mode",
        column: "product",
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("abstains when no column is named", () => {
    const r = parseQuestion("most common value", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a grouped mode instead of answering the whole-sheet mode", () => {
    const r = parseQuestion("most common product by region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one column/);
  });

  it("abstains on a time-grouped mode question", () => {
    const r = parseQuestion("most common region by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });
});

describe("parseQuestion distinct count", () => {
  it("parses 'how many distinct regions'", () => {
    expect(parseQuestion("how many distinct regions", SALES)).toEqual({
      ok: true,
      query: { kind: "distinctCount", column: "region", filters: [] },
    });
  });

  it("parses 'count distinct products'", () => {
    expect(parseQuestion("count distinct products", SALES)).toEqual({
      ok: true,
      query: { kind: "distinctCount", column: "product", filters: [] },
    });
  });

  it("abstains when no column is named", () => {
    const r = parseQuestion("how many distinct values", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a time-grouped distinct count", () => {
    const r = parseQuestion("how many distinct regions by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });

  it("still lists values for a bare 'list unique regions'", () => {
    expect(parseQuestion("list unique regions", SALES)).toEqual({
      ok: true,
      query: { kind: "distinct", column: "region", filters: [], limit: 20 },
    });
  });
});

describe("parseQuestion percentile", () => {
  it("parses '90th percentile of revenue'", () => {
    expect(parseQuestion("90th percentile of revenue", SALES)).toEqual({
      ok: true,
      query: { kind: "percentile", column: "revenue", p: 90, filters: [] },
    });
  });

  it("parses the short 'p90 revenue' form", () => {
    expect(parseQuestion("p90 revenue", SALES)).toEqual({
      ok: true,
      query: { kind: "percentile", column: "revenue", p: 90, filters: [] },
    });
  });

  it("parses 'what is the 25th percentile of salary'", () => {
    expect(parseQuestion("what is the 25th percentile of salary", STAFF)).toEqual({
      ok: true,
      query: { kind: "percentile", column: "salary", p: 25, filters: [] },
    });
  });

  it("keeps a filter on a percentile question", () => {
    expect(parseQuestion("90th percentile of revenue in North", SALES)).toEqual({
      ok: true,
      query: {
        kind: "percentile",
        column: "revenue",
        p: 90,
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("abstains when the percentile is outside 1-99", () => {
    const r = parseQuestion("150th percentile of revenue", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/between 1 and 99/);
  });

  it("abstains on a non-numeric column", () => {
    const r = parseQuestion("90th percentile of region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/numeric column/);
  });

  it("abstains when no column is named", () => {
    const r = parseQuestion("90th percentile", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a grouped percentile instead of answering the whole-sheet one", () => {
    const r = parseQuestion("90th percentile of revenue by region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one column/);
  });

  it("abstains on a time-grouped percentile question", () => {
    const r = parseQuestion("90th percentile of revenue by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });
});

describe("parseQuestion rank", () => {
  it("parses 'second highest salary'", () => {
    expect(parseQuestion("second highest salary", STAFF)).toEqual({
      ok: true,
      query: { kind: "rank", column: "salary", n: 2, direction: "highest", filters: [] },
    });
  });

  it("parses '3rd lowest revenue'", () => {
    expect(parseQuestion("3rd lowest revenue", SALES)).toEqual({
      ok: true,
      query: { kind: "rank", column: "revenue", n: 3, direction: "lowest", filters: [] },
    });
  });

  it("parses word and numeric ordinals with every direction word", () => {
    expect(parseQuestion("what is the 2nd largest revenue", SALES)).toEqual({
      ok: true,
      query: { kind: "rank", column: "revenue", n: 2, direction: "highest", filters: [] },
    });
    expect(parseQuestion("first smallest salary", STAFF)).toEqual({
      ok: true,
      query: { kind: "rank", column: "salary", n: 1, direction: "lowest", filters: [] },
    });
  });

  it("keeps a filter on a rank question", () => {
    expect(parseQuestion("second highest revenue in North", SALES)).toEqual({
      ok: true,
      query: {
        kind: "rank",
        column: "revenue",
        n: 2,
        direction: "highest",
        filters: [{ column: "region", op: "=", value: "North" }],
      },
    });
  });

  it("does not let 'second highest' fall through to the maximum", () => {
    // Before ranks existed this parsed as a plain max and answered
    // with the highest row — the silently wrong answer.
    const r = parseQuestion("second highest salary", STAFF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query.kind).toBe("rank");
  });

  it("abstains on a text column", () => {
    const r = parseQuestion("second highest region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a numeric column/);
  });

  it("abstains when no column is named", () => {
    const r = parseQuestion("second highest", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains when the rank is zero", () => {
    const r = parseQuestion("0th highest revenue", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/starts at 1/);
  });

  it("abstains on an unknown word instead of dropping it", () => {
    const r = parseQuestion("second highest frobnicate revenue", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not understand "frobnicate"/);
  });

  it("abstains on a grouped rank instead of answering the whole-sheet one", () => {
    const r = parseQuestion("second highest revenue by region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one column/);
  });

  it("abstains on a time-grouped rank question", () => {
    const r = parseQuestion("second highest revenue by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });
});

describe("parseQuestion trend", () => {
  const NODATES = parseCsv(
    "region,product,revenue\n" +
      "North,Widget A,240.00\n" +
      "South,Widget B,199.92\n",
  );

  it("parses a total trend over months", () => {
    const r = parseQuestion("revenue trend by month", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "trend",
        column: "revenue",
        op: "sum",
        dateColumn: "date",
        bucket: "month",
        filters: [],
      },
    });
  });

  it("parses an average trend over years on the staff sheet", () => {
    const r = parseQuestion("average salary trend by year", STAFF);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "trend",
        column: "salary",
        op: "mean",
        dateColumn: "start_date",
        bucket: "year",
        filters: [],
      },
    });
  });

  it("reads 'trending up' as trend intent", () => {
    const r = parseQuestion("is revenue trending up by month", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "trend",
        column: "revenue",
        op: "sum",
        dateColumn: "date",
        bucket: "month",
        filters: [],
      },
    });
  });

  it("carries a where filter into the trend", () => {
    const r = parseQuestion("revenue trend by month where region is North", SALES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.kind).toBe("trend");
      expect(r.query.filters).toEqual([{ column: "region", op: "=", value: "North" }]);
    }
  });

  it("abstains when no period is named", () => {
    const r = parseQuestion("revenue trend", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a period/);
  });

  it("abstains on a non-numeric column", () => {
    const r = parseQuestion("region trend by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/numeric column/);
  });

  it("abstains when the sheet has no date column", () => {
    const r = parseQuestion("revenue trend by month", NODATES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/date column/);
  });

  it("abstains when the sheet has two date columns", () => {
    const r = parseQuestion("revenue trend by month", DATES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/which date column/);
  });

  it("abstains on a trend plus a second group column", () => {
    const r = parseQuestion("revenue trend by month and region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one dimension/);
  });

  it("abstains on an unsupported period", () => {
    const r = parseQuestion("revenue trend by decade", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't group by decade/);
  });
});

describe("parseQuestion missing values", () => {
  it("parses 'how many rows are missing units' as a count", () => {
    expect(parseQuestion("how many rows are missing units", SALES)).toEqual({
      ok: true,
      query: { kind: "missing", column: "units", filters: [], listRows: false },
    });
  });

  it("parses 'how many rows are missing salaries' as a count — '-ies' plurals work", () => {
    expect(parseQuestion("how many rows are missing salaries", STAFF)).toEqual({
      ok: true,
      query: { kind: "missing", column: "salary", filters: [], listRows: false },
    });
  });

  it("parses 'show rows missing salaries' as a row listing", () => {
    expect(parseQuestion("show rows missing salaries", STAFF)).toEqual({
      ok: true,
      query: { kind: "missing", column: "salary", filters: [], listRows: true },
    });
  });

  it("parses 'how many rows are missing revenues' as a count", () => {
    expect(parseQuestion("how many rows are missing revenues", SALES)).toEqual({
      ok: true,
      query: { kind: "missing", column: "revenue", filters: [], listRows: false },
    });
  });

  it("parses 'count missing salary' as a count", () => {
    expect(parseQuestion("count missing salary", STAFF)).toEqual({
      ok: true,
      query: { kind: "missing", column: "salary", filters: [], listRows: false },
    });
  });

  it("parses 'which columns have missing values' as a whole-sheet report", () => {
    expect(parseQuestion("which columns have missing values", SALES)).toEqual({
      ok: true,
      query: { kind: "missing", column: null, filters: [], listRows: false },
    });
  });

  it("parses 'how many blank cells are there in units'", () => {
    expect(parseQuestion("how many blank cells are there in units", SALES)).toEqual({
      ok: true,
      query: { kind: "missing", column: "units", filters: [], listRows: false },
    });
  });

  it("parses 'show rows missing salary' as a row listing", () => {
    expect(parseQuestion("show rows missing salary", STAFF)).toEqual({
      ok: true,
      query: { kind: "missing", column: "salary", filters: [], listRows: true },
    });
  });

  it("parses 'which rows are missing revenue' as a row listing", () => {
    expect(parseQuestion("which rows are missing revenue", SALES)).toEqual({
      ok: true,
      query: { kind: "missing", column: "revenue", filters: [], listRows: true },
    });
  });

  it("keeps a filter on a missing-values question", () => {
    expect(parseQuestion("how many rows are missing salary in Engineering", STAFF)).toEqual({
      ok: true,
      query: {
        kind: "missing",
        column: "salary",
        filters: [{ column: "department", op: "=", value: "Engineering" }],
        listRows: false,
      },
    });
  });

  it("abstains when the column does not exist", () => {
    const r = parseQuestion("how many rows are missing profit", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a grouped missing question instead of answering the whole-sheet count", () => {
    const r = parseQuestion("how many rows are missing revenue by region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one column/);
  });

  it("abstains on a time-grouped missing question", () => {
    const r = parseQuestion("how many rows are missing revenue by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });

  it("abstains when listing rows with no column named", () => {
    const r = parseQuestion("show rows missing values", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs one column/);
  });

  it("abstains on an ambiguous column", () => {
    const r = parseQuestion("how many rows are missing units revenue", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not tell which column/);
  });
});

describe("parseQuestion outliers", () => {
  it("parses 'how many outliers in revenue' as a count", () => {
    expect(parseQuestion("how many outliers in revenue", SALES)).toEqual({
      ok: true,
      query: { kind: "outliers", column: "revenue", filters: [], listRows: false },
    });
  });

  it("parses 'how many outliers in salaries' as a count — '-ies' plurals work", () => {
    expect(parseQuestion("how many outliers in salaries", STAFF)).toEqual({
      ok: true,
      query: { kind: "outliers", column: "salary", filters: [], listRows: false },
    });
  });

  it("parses 'how many outliers in revenues' as a count", () => {
    expect(parseQuestion("how many outliers in revenues", SALES)).toEqual({
      ok: true,
      query: { kind: "outliers", column: "revenue", filters: [], listRows: false },
    });
  });

  it("parses 'show outliers in revenues' as a row listing", () => {
    expect(parseQuestion("show outliers in revenues", SALES)).toEqual({
      ok: true,
      query: { kind: "outliers", column: "revenue", filters: [], listRows: true },
    });
  });

  it("still abstains on a genuinely unknown trailing word", () => {
    const r = parseQuestion("how many outliers in revenue xyz", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not understand "xyz"/);
  });

  it("parses 'count outliers in units' as a count", () => {
    expect(parseQuestion("count outliers in units", SALES)).toEqual({
      ok: true,
      query: { kind: "outliers", column: "units", filters: [], listRows: false },
    });
  });

  it("parses 'which columns have outliers' as a whole-sheet report", () => {
    expect(parseQuestion("which columns have outliers", SALES)).toEqual({
      ok: true,
      query: { kind: "outliers", column: null, filters: [], listRows: false },
    });
  });

  it("parses 'show outliers in revenue' as a row listing", () => {
    expect(parseQuestion("show outliers in revenue", SALES)).toEqual({
      ok: true,
      query: { kind: "outliers", column: "revenue", filters: [], listRows: true },
    });
  });

  it("parses 'which rows are outliers in salary' as a row listing", () => {
    expect(parseQuestion("which rows are outliers in salary", STAFF)).toEqual({
      ok: true,
      query: { kind: "outliers", column: "salary", filters: [], listRows: true },
    });
  });

  it("keeps a filter on an outlier question", () => {
    expect(parseQuestion("how many outliers in salary in Engineering", STAFF)).toEqual({
      ok: true,
      query: {
        kind: "outliers",
        column: "salary",
        filters: [{ column: "department", op: "=", value: "Engineering" }],
        listRows: false,
      },
    });
  });

  it("abstains on a text column — outliers need numbers", () => {
    const r = parseQuestion("how many outliers in region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/numeric column/);
  });

  it("abstains when the column does not exist", () => {
    const r = parseQuestion("how many outliers in profit", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a grouped outlier question instead of answering the whole-sheet count", () => {
    const r = parseQuestion("how many outliers in revenue by region", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one column/);
  });

  it("abstains on a time-grouped outlier question", () => {
    const r = parseQuestion("how many outliers in revenue by month", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't be grouped by a time period/);
  });

  it("abstains when listing rows with no column named", () => {
    const r = parseQuestion("show outlier rows", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs one column/);
  });

  it("abstains on an ambiguous column", () => {
    const r = parseQuestion("how many outliers in units revenue", SALES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not tell which column/);
  });
});

// North/Widget A/12 appears 3 times, South/Widget B/8 twice:
// 3 exact duplicate rows; product has 4 duplicate rows over 2
// repeated values, region and units 3 each.
const DUPS = parseCsv(
  "region,product,units\n" +
    "North,Widget A,12\n" +
    "South,Widget B,8\n" +
    "North,Widget A,12\n" +
    "East,Widget C,5\n" +
    "South,Widget B,8\n" +
    "North,Widget A,12\n" +
    "West,Widget B,3\n",
);

describe("parseQuestion duplicates", () => {
  it("parses 'how many duplicate rows' as a whole-sheet report", () => {
    expect(parseQuestion("how many duplicate rows", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: null, filters: [], listRows: false },
    });
  });

  it("parses 'are there duplicate rows' as a whole-sheet report", () => {
    expect(parseQuestion("are there duplicate rows", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: null, filters: [], listRows: false },
    });
  });

  it("parses 'how many duplicate products' as a count — plural column names work", () => {
    expect(parseQuestion("how many duplicate products", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: "product", filters: [], listRows: false },
    });
  });

  it("parses 'how many duplicate salaries' as a count — '-ies' plurals work", () => {
    expect(parseQuestion("how many duplicate salaries", STAFF)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: "salary", filters: [], listRows: false },
    });
  });

  it("parses 'count duplicates in region' as a count", () => {
    expect(parseQuestion("count duplicates in region", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: "region", filters: [], listRows: false },
    });
  });

  it("parses 'which columns have duplicates' as a whole-sheet report", () => {
    expect(parseQuestion("which columns have duplicates", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: null, filters: [], listRows: false },
    });
  });

  it("parses 'show duplicate rows' as a listing of the exact duplicate rows", () => {
    expect(parseQuestion("show duplicate rows", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: null, filters: [], listRows: true },
    });
  });

  it("parses 'show duplicates in product' as a row listing", () => {
    expect(parseQuestion("show duplicates in product", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: "product", filters: [], listRows: true },
    });
  });

  it("parses 'which rows are duplicates' as a listing even with no column named", () => {
    expect(parseQuestion("which rows are duplicates", DUPS)).toEqual({
      ok: true,
      query: { kind: "duplicates", column: null, filters: [], listRows: true },
    });
  });

  it("keeps a filter on a duplicate question", () => {
    expect(parseQuestion("how many duplicates in product in North", DUPS)).toEqual({
      ok: true,
      query: {
        kind: "duplicates",
        column: "product",
        filters: [{ column: "region", op: "=", value: "North" }],
        listRows: false,
      },
    });
  });

  it("abstains when the column does not exist", () => {
    const r = parseQuestion("how many duplicates in profit", DUPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no column named/);
  });

  it("abstains on a grouped duplicate question instead of answering the whole-sheet count", () => {
    const r = parseQuestion("how many duplicate products by region", DUPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one column/);
  });

  it("abstains on an ambiguous column", () => {
    const r = parseQuestion("how many duplicates in units region", DUPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not tell which column/);
  });
});
