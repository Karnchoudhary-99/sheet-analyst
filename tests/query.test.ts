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
      query: { kind: "group", groupBy: "department", column: null, op: "count", filters: [] },
    });
  });
});

describe("parseQuestion group-by", () => {
  it("groups a total by a column", () => {
    const r = parseQuestion("total revenue by region", SALES);
    expect(r).toEqual({
      ok: true,
      query: { kind: "group", groupBy: "region", column: "revenue", op: "sum", filters: [] },
    });
  });

  it("accepts 'per' as the group marker", () => {
    const r = parseQuestion("average salary per department", STAFF);
    expect(r).toEqual({
      ok: true,
      query: { kind: "group", groupBy: "department", column: "salary", op: "mean", filters: [] },
    });
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
        groupBy: "product",
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
});

describe("parseQuestion time grouping", () => {
  it("groups a total by month using the sheet's only date column", () => {
    const r = parseQuestion("total revenue by month", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "group",
        groupBy: "date",
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
        expect(r.query.groupBy).toBe("start_date");
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
      expect(r.query.groupBy).toBe("start_date");
      expect(r.query.bucket).toBe("month");
    }
  });

  it("counts rows by month", () => {
    const r = parseQuestion("how many rows by month", SALES);
    expect(r).toEqual({
      ok: true,
      query: {
        kind: "group",
        groupBy: "date",
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
        groupBy: "date",
        filters: [],
        bucket: "month",
      },
    });
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
