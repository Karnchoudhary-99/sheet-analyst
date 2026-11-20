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
