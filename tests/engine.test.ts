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
