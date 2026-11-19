import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import { executeQuery } from "../src/engine.js";
import { parseQuestion } from "../src/query.js";

const SALES = parseCsv(
  "date,region,product,units,revenue\n" +
    "2026-01-05,North,Widget A,12,240.00\n" +
    "2026-01-06,South,Widget B,8,199.92\n" +
    "2026-01-07,North,Widget C,3,149.97\n" +
    "2026-01-08,East,Widget A,20,400.00\n" +
    "2026-01-09,West,Widget B,5,124.95\n" +
    "2026-01-10,North,Widget A,,0.00\n",
);

const STAFF = parseCsv(
  "id,name,department,salary,start_date,remote\n" +
    "1,Ada,Engineering,95000,2024-03-01,true\n" +
    "2,Grace,Engineering,98000,2023-07-15,true\n" +
    "3,Alan,Data,88000,2025-01-20,false\n",
);

/** Parse a question and run it; throws if the parser abstains. */
function ask(question: string, sheet = SALES) {
  const parsed = parseQuestion(question, sheet);
  if (!parsed.ok) throw new Error(`abstained: ${parsed.reason}`);
  return executeQuery(parsed.query, sheet);
}

describe("executeQuery aggregates", () => {
  it("sums a numeric column", () => {
    const r = ask("total revenue");
    expect(r.kind).toBe("scalar");
    if (r.kind === "scalar") {
      expect(r.value).toBeCloseTo(1114.84, 2);
      expect(r.rowsMatched).toBe(6);
      expect(r.valuesUsed).toBe(6);
    }
  });

  it("averages and medians skip nulls", () => {
    const mean = ask("average units");
    if (mean.kind === "scalar") {
      expect(mean.value).toBeCloseTo(9.6, 5);
      expect(mean.valuesUsed).toBe(5); // one blank units cell
    }
    const median = ask("median revenue");
    if (median.kind === "scalar") expect(median.value).toBeCloseTo(174.945, 3);
  });

  it("returns null when a column has no usable values", () => {
    const sheet = parseCsv("x,y\n,1\n,2\n");
    const r = executeQuery(
      { kind: "aggregate", column: "x", op: "sum", filters: [] },
      sheet,
    );
    expect(r.kind).toBe("scalar");
    if (r.kind === "scalar") {
      expect(r.value).toBeNull();
      expect(r.valuesUsed).toBe(0);
    }
  });

  it("counts matching rows", () => {
    const r = ask("how many rows");
    if (r.kind === "scalar") expect(r.value).toBe(6);
  });
});

describe("executeQuery filters", () => {
  it("filters by categorical equality", () => {
    const r = ask("total revenue where region is North");
    if (r.kind === "scalar") {
      expect(r.value).toBeCloseTo(389.97, 2);
      expect(r.rowsMatched).toBe(3);
    }
  });

  it("filters by numeric comparison", () => {
    const r = ask("how many rows where revenue > 200");
    if (r.kind === "scalar") expect(r.value).toBe(2);
    const r2 = ask("total revenue where units >= 10");
    if (r2.kind === "scalar") expect(r2.value).toBeCloseTo(640, 2);
  });

  it("filters by date comparison", () => {
    const r = ask("how many rows where start_date after 2024-01-01", STAFF);
    if (r.kind === "scalar") expect(r.value).toBe(2);
  });

  it("is case-insensitive for text filters", () => {
    const r = ask("total revenue where region is north");
    if (r.kind === "scalar") expect(r.value).toBeCloseTo(389.97, 2);
  });

  it("returns the matching rows for a rows query", () => {
    const r = ask("show rows where region is North");
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.totalMatched).toBe(3);
      expect(r.rows).toHaveLength(3);
      expect(r.rows[0].product).toBe("Widget A");
    }
  });
});

describe("executeQuery groups", () => {
  it("groups a total by region, largest first", () => {
    const r = ask("total revenue by region");
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      expect(r.groups.map((g) => [g.key, g.value])).toEqual([
        ["East", 400],
        ["North", 389.97],
        ["South", 199.92],
        ["West", 124.95],
      ]);
    }
  });

  it("groups a count when no column is named", () => {
    const r = ask("how many employees by department", STAFF);
    if (r.kind === "groups") {
      expect(r.groups).toEqual([
        { key: "Engineering", value: 2, count: 2 },
        { key: "Data", value: 1, count: 1 },
      ]);
    }
  });

  it("averages per group", () => {
    const r = ask("average salary by department", STAFF);
    if (r.kind === "groups") {
      expect(r.groups[0].key).toBe("Engineering");
      expect(r.groups[0].value).toBeCloseTo(96500, 5);
      expect(r.groups[1].value).toBeCloseTo(88000, 5);
    }
  });
});

describe("executeQuery top-N", () => {
  it("ranks groups by summed column", () => {
    const r = ask("top 2 products by revenue");
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      expect(r.groups).toEqual([
        { key: "Widget A", value: 640, count: 3 },
        { key: "Widget B", value: 324.87, count: 2 },
      ]);
      expect(r.limitedTo).toBe(2);
    }
  });

  it("ranks rows by the column", () => {
    const r = ask("top 2 revenue");
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0].revenue).toBe("400.00");
      expect(r.rows[1].revenue).toBe("240.00");
      expect(r.totalMatched).toBe(6);
    }
  });

  it("finds the lowest rows on request", () => {
    const r = ask("lowest 1 salary", STAFF);
    if (r.kind === "rows") {
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].name).toBe("Alan");
    }
  });
});

describe("executeQuery time bucketing", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,12,240.00\n" +
      "2026-01-20,South,Widget B,8,199.92\n" +
      "2026-02-03,East,Widget A,20,400.00\n" +
      "2026-02-10,West,Widget B,5,124.95\n" +
      "2026-03-02,North,Widget C,15,449.85\n" +
      "2026-03-15,East,Widget B,9,224.91\n" +
      ",South,Widget A,3,60.00\n",
  );

  it("groups monthly totals in chronological order", () => {
    const r = ask("total revenue by month", MONTHLY);
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      expect(r.bucket).toBe("month");
      // toEqual on sums would fail on float dust (240 + 199.92 is
      // 439.91999999999996 in binary), so compare each value loosely.
      expect(r.groups.map((g) => g.key)).toEqual([
        "Jan 2026",
        "Feb 2026",
        "Mar 2026",
        "(no date)",
      ]);
      expect(r.groups.map((g) => g.count)).toEqual([2, 2, 2, 1]);
      expect(r.groups[0].value).toBeCloseTo(439.92, 2);
      expect(r.groups[1].value).toBeCloseTo(524.95, 2);
      expect(r.groups[2].value).toBeCloseTo(674.76, 2);
      expect(r.groups[3].value).toBeCloseTo(60, 2);
      expect(r.rowsMatched).toBe(7);
    }
  });

  it("buckets a whole quarter into one group", () => {
    const r = ask("total revenue by quarter", MONTHLY);
    if (r.kind === "groups") {
      expect(r.groups).toEqual([
        { key: "Q1 2026", value: 1639.63, count: 6 },
        { key: "(no date)", value: 60, count: 1 },
      ]);
    }
  });

  it("counts rows per month, undated rows last", () => {
    const r = ask("how many rows by month", MONTHLY);
    if (r.kind === "groups") {
      expect(r.groups.map((g) => `${g.key}:${g.value}`).join(",")).toBe(
        "Jan 2026:2,Feb 2026:2,Mar 2026:2,(no date):1",
      );
    }
  });

  it("ranks periods by value for top-N over months", () => {
    const r = ask("top 2 months by revenue", MONTHLY);
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      expect(r.groups).toEqual([
        { key: "Mar 2026", value: 674.76, count: 2 },
        { key: "Feb 2026", value: 524.95, count: 2 },
      ]);
      expect(r.limitedTo).toBe(2);
      expect(r.totalGroups).toBe(4);
    }
  });

  it("still compares dates by day in filters", () => {
    const r = ask("total revenue where date is after 2026-02-01", MONTHLY);
    if (r.kind === "scalar") {
      // Feb + Mar only; the undated row never matches a date filter.
      expect(r.value).toBeCloseTo(1199.71, 2);
      expect(r.rowsMatched).toBe(4);
    }
  });
});
