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

  it("filters by an inclusive between-range", () => {
    const r = ask("total revenue where revenue between 100 and 200");
    if (r.kind === "scalar") {
      // 199.92 + 149.97 + 124.95; the 240 and 400 rows are outside.
      expect(r.value).toBeCloseTo(474.84, 2);
      expect(r.rowsMatched).toBe(3);
    }
    const counted = ask("how many rows where revenue between 100 and 200");
    if (counted.kind === "scalar") expect(counted.value).toBe(3);
  });

  it("filters by a between-range over dates", () => {
    const r = ask("how many rows where date between 2026-01-06 and 2026-01-08");
    if (r.kind === "scalar") expect(r.value).toBe(3);
  });
});

describe("executeQuery sorted rows", () => {
  it("sorts numerically, highest first when descending", () => {
    const r = ask("show rows sorted by revenue descending");
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.rows.map((row) => row.revenue)).toEqual([
        "400.00",
        "240.00",
        "199.92",
        "149.97",
        "124.95",
        "0.00",
      ]);
      expect(r.sortedBy).toEqual({ column: "revenue", direction: "desc" });
    }
  });

  it("sorts ascending by default, lowest first", () => {
    const r = ask("show rows sorted by revenue");
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.rows.map((row) => row.revenue)).toEqual([
        "0.00",
        "124.95",
        "149.97",
        "199.92",
        "240.00",
        "400.00",
      ]);
    }
  });

  it("sorts blank cells last in both directions", () => {
    const desc = ask("show rows sorted by units descending");
    const asc = ask("show rows sorted by units ascending");
    expect(desc.kind).toBe("rows");
    expect(asc.kind).toBe("rows");
    if (desc.kind === "rows") {
      expect(desc.rows.map((row) => row.units)).toEqual(["20", "12", "8", "5", "3", ""]);
    }
    if (asc.kind === "rows") {
      expect(asc.rows.map((row) => row.units)).toEqual(["3", "5", "8", "12", "20", ""]);
    }
  });

  it("sorts text alphabetically, case-insensitively", () => {
    const r = ask("show rows sorted by region");
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.rows.map((row) => row.region)).toEqual([
        "East",
        "North",
        "North",
        "North",
        "South",
        "West",
      ]);
    }
  });

  it("sorts dates chronologically", () => {
    const r = ask("show rows sorted by start_date descending", STAFF);
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.rows.map((row) => row.start_date)).toEqual([
        "2025-01-20",
        "2024-03-01",
        "2023-07-15",
      ]);
    }
  });

  it("sorts before slicing, so the limit keeps the sorted top", () => {
    // The 400.00 row is fourth in the sheet; with limit 3 it only
    // appears when the sort runs before the slice.
    const r = executeQuery(
      {
        kind: "rows",
        filters: [],
        limit: 3,
        sort: { column: "revenue", direction: "desc" },
      },
      SALES,
    );
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.totalMatched).toBe(6);
      expect(r.rows.map((row) => row.revenue)).toEqual(["400.00", "240.00", "199.92"]);
      expect(r.limitedTo).toBe(3);
    }
  });
});

describe("executeQuery above/below average", () => {
  it("returns the rows strictly above the mean, in sheet order", () => {
    // Revenues total 1,114.84 over 6 rows, mean 185.81.
    const r = ask("rows with revenue above average");
    expect(r.kind).toBe("aboveBelow");
    if (r.kind === "aboveBelow") {
      expect(r.threshold).toBeCloseTo(185.81, 2);
      expect(r.baseline).toBe("average");
      expect(r.direction).toBe("above");
      expect(r.totalMatched).toBe(3);
      expect(r.rowsMatched).toBe(6);
      expect(r.rows.map((row) => row.revenue)).toEqual(["240.00", "199.92", "400.00"]);
    }
  });

  it("returns the rows strictly below the mean", () => {
    const r = ask("rows with revenue below average");
    expect(r.kind).toBe("aboveBelow");
    if (r.kind === "aboveBelow") {
      expect(r.totalMatched).toBe(3);
      expect(r.rows.map((row) => row.revenue)).toEqual(["149.97", "124.95", "0.00"]);
    }
  });

  it("compares against the median when asked", () => {
    // Revenues sorted: 0, 124.95, 149.97, 199.92, 240, 400 —
    // median (149.97 + 199.92) / 2 = 174.945. Rows come back in
    // sheet order, not sorted: 240 precedes 199.92 in the sheet.
    const r = ask("rows with revenue above the median");
    expect(r.kind).toBe("aboveBelow");
    if (r.kind === "aboveBelow") {
      expect(r.threshold).toBeCloseTo(174.95, 2);
      expect(r.baseline).toBe("median");
      expect(r.rows.map((row) => row.revenue)).toEqual(["240.00", "199.92", "400.00"]);
    }
  });

  it("skips blank values when computing the baseline", () => {
    // Units: 12, 8, 3, 20, 5 and one blank — mean 9.6 over 5 values.
    const r = ask("rows with units above average");
    expect(r.kind).toBe("aboveBelow");
    if (r.kind === "aboveBelow") {
      expect(r.threshold).toBeCloseTo(9.6, 2);
      expect(r.rows.map((row) => row.units)).toEqual(["12", "20"]);
    }
  });

  it("excludes rows exactly at the baseline", () => {
    const sheet = parseCsv("x\n10\n20\n30\n");
    const r = executeQuery(
      { kind: "aboveBelow", column: "x", direction: "above", baseline: "average", filters: [] },
      sheet,
    );
    expect(r.kind).toBe("aboveBelow");
    if (r.kind === "aboveBelow") {
      expect(r.threshold).toBe(20);
      expect(r.totalMatched).toBe(1);
      expect(r.rows.map((row) => row.x)).toEqual(["30"]);
    }
    const below = executeQuery(
      { kind: "aboveBelow", column: "x", direction: "below", baseline: "average", filters: [] },
      sheet,
    );
    if (below.kind === "aboveBelow") {
      expect(below.rows.map((row) => row.x)).toEqual(["10"]);
    }
  });

  it("reports a null threshold when no row has a usable value", () => {
    const sheet = parseCsv("name,score\nA,\nB,\n");
    const r = executeQuery(
      { kind: "aboveBelow", column: "score", direction: "above", baseline: "average", filters: [] },
      sheet,
    );
    expect(r.kind).toBe("aboveBelow");
    if (r.kind === "aboveBelow") {
      expect(r.threshold).toBeNull();
      expect(r.totalMatched).toBe(0);
      expect(r.rows).toEqual([]);
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
        { key: "Engineering", keys: ["Engineering"], value: 2, count: 2 },
        { key: "Data", keys: ["Data"], value: 1, count: 1 },
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

describe("executeQuery multi-column groups", () => {
  it("groups a total by two columns, largest first", () => {
    const r = ask("total revenue by region and product");
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      expect(r.groupBy).toEqual(["region", "product"]);
      expect(r.groups.map((g) => [g.key, g.value, g.count])).toEqual([
        ["East · Widget A", 400, 1],
        ["North · Widget A", 240, 2],
        ["South · Widget B", 199.92, 1],
        ["North · Widget C", 149.97, 1],
        ["West · Widget B", 124.95, 1],
      ]);
      expect(r.groups[0].keys).toEqual(["East", "Widget A"]);
      expect(r.totalGroups).toBe(5);
    }
  });

  it("counts rows per two-column group", () => {
    const r = ask("how many employees by department and remote", STAFF);
    if (r.kind === "groups") {
      expect(r.groups).toEqual([
        { key: "Engineering · true", keys: ["Engineering", "true"], value: 2, count: 2 },
        { key: "Data · false", keys: ["Data", "false"], value: 1, count: 1 },
      ]);
    }
  });

  it("labels blank cells as (blank) inside a composite key", () => {
    const messy = parseCsv(
      "region,product,revenue\n" +
        "North,Widget A,100\n" +
        ",Widget A,50\n" +
        "North,,25\n",
    );
    const r = ask("total revenue by region and product", messy);
    if (r.kind === "groups") {
      expect(r.groups.map((g) => [g.key, g.value])).toEqual([
        ["North · Widget A", 100],
        ["(blank) · Widget A", 50],
        ["North · (blank)", 25],
      ]);
      expect(r.groups[1].keys).toEqual(["(blank)", "Widget A"]);
    }
  });

  it("breaks value ties by the composite key, alphabetically", () => {
    const tied = parseCsv(
      "region,product,revenue\n" +
        "South,Widget A,100\n" +
        "North,Widget B,100\n" +
        "East,Widget A,100\n",
    );
    const r = ask("total revenue by region and product", tied);
    if (r.kind === "groups") {
      expect(r.groups.map((g) => g.key)).toEqual([
        "East · Widget A",
        "North · Widget B",
        "South · Widget A",
      ]);
    }
  });
});

describe("executeQuery top-N", () => {
  it("ranks groups by summed column", () => {
    const r = ask("top 2 products by revenue");
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      expect(r.groups).toEqual([
        { key: "Widget A", keys: ["Widget A"], value: 640, count: 3 },
        { key: "Widget B", keys: ["Widget B"], value: 324.87, count: 2 },
      ]);
      expect(r.limitedTo).toBe(2);
    }
  });

  it("ranks two-column combinations", () => {
    const r = ask("top 2 region and product by revenue");
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      expect(r.groupBy).toEqual(["region", "product"]);
      expect(r.groups.map((g) => [g.key, g.value])).toEqual([
        ["East · Widget A", 400],
        ["North · Widget A", 240],
      ]);
      expect(r.groups[1].keys).toEqual(["North", "Widget A"]);
      expect(r.limitedTo).toBe(2);
      expect(r.totalGroups).toBe(5);
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

  it("ranks groups ascending for bottom-N", () => {
    const r = ask("bottom 2 products by revenue");
    expect(r.kind).toBe("groups");
    if (r.kind === "groups") {
      // SALES fixture: Widget A 640, Widget B 324.87, Widget C 149.97.
      expect(r.groups).toEqual([
        { key: "Widget C", keys: ["Widget C"], value: 149.97, count: 1 },
        { key: "Widget B", keys: ["Widget B"], value: 324.87, count: 2 },
      ]);
      expect(r.limitedTo).toBe(2);
      expect(r.totalGroups).toBe(3);
      expect(r.direction).toBe("lowest");
    }
  });

  it("marks a highest-direction ranking as highest", () => {
    const r = ask("top 2 products by revenue");
    if (r.kind === "groups") {
      expect(r.direction).toBe("highest");
    }
  });

  it("finds the bottom row for a bare 'bottom'", () => {
    const r = ask("bottom revenue");
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") {
      expect(r.rows).toHaveLength(1);
      // The zero-revenue row is the lowest single row.
      expect(r.rows[0].revenue).toBe("0.00");
      expect(r.rows[0].product).toBe("Widget A");
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
        { key: "Q1 2026", keys: ["Q1 2026"], value: 1639.63, count: 6 },
        { key: "(no date)", keys: ["(no date)"], value: 60, count: 1 },
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
        { key: "Mar 2026", keys: ["Mar 2026"], value: 674.76, count: 2 },
        { key: "Feb 2026", keys: ["Feb 2026"], value: 524.95, count: 2 },
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

describe("executeQuery correlation", () => {
  it("computes Pearson r over the paired rows only", () => {
    // The blank-units row pairs with nothing, so 5 pairs, not 6.
    const r = ask("correlation between revenue and units");
    expect(r.kind).toBe("correlation");
    if (r.kind === "correlation") {
      expect(r.value).toBeCloseTo(0.9761, 4);
      expect(r.pairs).toBe(5);
      expect(r.rowsMatched).toBe(6);
    }
  });

  it("respects filters when pairing", () => {
    const r = ask("correlation between revenue and units where region is North");
    expect(r.kind).toBe("correlation");
    if (r.kind === "correlation") {
      // North rows: (12, 240), (3, 149.97) — the blank-units row drops out.
      expect(r.pairs).toBe(2);
      expect(r.rowsMatched).toBe(3);
      expect(r.value).toBeCloseTo(1, 4);
    }
  });

  it("yields null for a constant column", () => {
    const flat = parseCsv("a,b\n1,5\n2,5\n3,5\n");
    const r = ask("correlation between a and b", flat);
    expect(r.kind).toBe("correlation");
    if (r.kind === "correlation") {
      expect(r.value).toBeNull();
      expect(r.pairs).toBe(3);
    }
  });

  it("yields null with fewer than two pairs", () => {
    const sparse = parseCsv("a,b\n1,\n,2\n");
    const r = ask("correlation between a and b", sparse);
    expect(r.kind).toBe("correlation");
    if (r.kind === "correlation") {
      expect(r.value).toBeNull();
      expect(r.pairs).toBe(0);
    }
  });
});

describe("executeQuery comparison", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,10,200.00\n" +
      "2026-01-12,South,Widget B,5,124.95\n" +
      "2026-02-03,North,Widget B,12,299.88\n" +
      "2026-02-10,South,Widget A,6,120.00\n" +
      "2026-03-02,North,Widget C,3,134.97\n",
  );

  it("computes totals, delta and percent change between two months", () => {
    const r = ask("compare revenue Jan 2026 vs Feb 2026", MONTHLY);
    expect(r.kind).toBe("comparison");
    if (r.kind !== "comparison") return;
    expect(r.periodA).toEqual({ label: "Jan 2026", value: 324.95, rows: 2, valuesUsed: 2 });
    expect(r.periodB).toEqual({ label: "Feb 2026", value: 419.88, rows: 2, valuesUsed: 2 });
    expect(r.delta).toBeCloseTo(94.93, 2);
    expect(r.pctChange).toBeCloseTo(29.21, 2);
    expect(r.rowsMatched).toBe(4);
  });

  it("reports a fall with a negative delta and percent", () => {
    const r = ask("revenue change from February to March", MONTHLY);
    expect(r.kind).toBe("comparison");
    if (r.kind !== "comparison") return;
    expect(r.periodA.value).toBeCloseTo(419.88, 2);
    expect(r.periodB.value).toBeCloseTo(134.97, 2);
    expect(r.delta).toBeCloseTo(-284.91, 2);
    expect(r.pctChange).toBeCloseTo(-67.86, 2);
  });

  it("compares averages, not just totals", () => {
    const r = ask("compare average revenue Jan 2026 vs Feb 2026", MONTHLY);
    if (r.kind !== "comparison") throw new Error("wrong kind");
    expect(r.periodA.value).toBeCloseTo(162.475, 2);
    expect(r.periodB.value).toBeCloseTo(209.94, 2);
  });

  it("compares row counts when no column is named", () => {
    const sparse = parseCsv(
      "date,product,revenue\n" +
        "2026-01-05,Widget A,200\n" +
        "2026-02-03,Widget B,300\n" +
        "2026-02-10,Widget A,120\n",
    );
    const r = ask("compare rows in Jan vs Feb", sparse);
    if (r.kind !== "comparison") throw new Error("wrong kind");
    expect(r.column).toBeNull();
    expect(r.periodA.value).toBe(1);
    expect(r.periodB.value).toBe(2);
    expect(r.delta).toBe(1);
    expect(r.pctChange).toBe(100);
  });

  it("leaves delta and percent null when a period has no rows", () => {
    const r = ask("compare revenue Jan 2026 vs Feb 2026", SALES);
    if (r.kind !== "comparison") throw new Error("wrong kind");
    expect(r.periodA.value).toBeCloseTo(1114.84, 2);
    expect(r.periodB.value).toBeNull();
    expect(r.periodB.rows).toBe(0);
    expect(r.delta).toBeNull();
    expect(r.pctChange).toBeNull();
  });

  it("leaves percent null when the baseline period totals zero", () => {
    const zero = parseCsv(
      "date,product,revenue\n" +
        "2026-01-05,Widget A,0\n" +
        "2026-02-03,Widget B,300\n",
    );
    const r = ask("compare revenue Jan vs Feb", zero);
    if (r.kind !== "comparison") throw new Error("wrong kind");
    expect(r.periodA.value).toBe(0);
    expect(r.delta).toBe(300);
    expect(r.pctChange).toBeNull();
  });
});

describe("executeQuery share", () => {
  it("shares out a filtered subset's total against the whole sheet", () => {
    const r = ask("what share of revenue is North");
    expect(r).toEqual({
      kind: "share",
      column: "revenue",
      filters: [{ column: "region", op: "=", value: "North" }],
      subsetValue: 389.97,
      totalValue: 1114.84,
      share: 389.97 / 1114.84,
      subsetRows: 3,
      totalRows: 6,
      valuesUsed: 3,
      totalValuesUsed: 6,
    });
  });

  it("shares out row counts", () => {
    const r = ask("what share of rows are in North");
    expect(r).toEqual({
      kind: "share",
      column: null,
      filters: [{ column: "region", op: "=", value: "North" }],
      subsetValue: 3,
      totalValue: 6,
      share: 0.5,
      subsetRows: 3,
      totalRows: 6,
      valuesUsed: 3,
      totalValuesUsed: 6,
    });
  });

  it("skips nulls on both sides of a value share", () => {
    // North units are 12 + 3 (the blank row contributes nothing);
    // the sheet total is 48 over 5 valued rows.
    const r = ask("what share of units is North");
    expect(r.kind).toBe("share");
    if (r.kind === "share") {
      expect(r.subsetValue).toBe(15);
      expect(r.totalValue).toBe(48);
      expect(r.share).toBeCloseTo(15 / 48, 10);
      expect(r.valuesUsed).toBe(2);
      expect(r.totalValuesUsed).toBe(5);
    }
  });

  it("returns a null share when the whole-sheet total is zero", () => {
    const zeros = parseCsv("a,b\n1,0\n2,0\n");
    const r = executeQuery(
      {
        kind: "share",
        column: "b",
        filters: [{ column: "a", op: "=", value: "1" }],
      },
      zeros,
    );
    expect(r.kind).toBe("share");
    if (r.kind === "share") {
      expect(r.subsetValue).toBe(0);
      expect(r.totalValue).toBe(0);
      expect(r.share).toBeNull();
    }
  });
});

describe("executeQuery distinct values", () => {
  it("lists distinct values most frequent first with row counts", () => {
    const r = ask("list unique regions");
    expect(r).toEqual({
      kind: "values",
      column: "region",
      values: [
        { value: "North", count: 3 },
        { value: "East", count: 1 },
        { value: "South", count: 1 },
        { value: "West", count: 1 },
      ],
      totalDistinct: 4,
      limitedTo: undefined,
      rowsMatched: 6,
    });
  });

  it("respects filters when listing values", () => {
    const r = ask("list unique products in North");
    expect(r.kind).toBe("values");
    if (r.kind === "values") {
      // North rows are Widget A (twice) and Widget C (once).
      expect(r.values).toEqual([
        { value: "Widget A", count: 2 },
        { value: "Widget C", count: 1 },
      ]);
      expect(r.totalDistinct).toBe(2);
      expect(r.rowsMatched).toBe(3);
    }
  });

  it("never lists blank cells as values", () => {
    const r = ask("list unique units");
    expect(r.kind).toBe("values");
    if (r.kind === "values") {
      // The blank-units row contributes no value; 5 distinct numbers remain.
      expect(r.totalDistinct).toBe(5);
      expect(r.values.every((v) => v.value !== "")).toBe(true);
      expect(r.rowsMatched).toBe(6);
    }
  });

  it("slices to the limit and reports the total", () => {
    const r = executeQuery(
      { kind: "distinct", column: "region", filters: [], limit: 2 },
      SALES,
    );
    expect(r.kind).toBe("values");
    if (r.kind === "values") {
      expect(r.values).toEqual([
        { value: "North", count: 3 },
        { value: "East", count: 1 },
      ]);
      expect(r.totalDistinct).toBe(4);
      expect(r.limitedTo).toBe(2);
    }
  });
});

describe("executeQuery mode", () => {
  it("returns the most frequent value with its count and distinct total", () => {
    const r = ask("most common region");
    expect(r).toEqual({
      kind: "mode",
      column: "region",
      value: "North",
      count: 3,
      totalDistinct: 4,
      rowsMatched: 6,
      valuesUsed: 6,
    });
  });

  it("breaks ties alphabetically, like the distinct-values listing", () => {
    // Two colours tie at 2 rows each; "blue" wins over "red".
    const tied = parseCsv(
      "colour,shape\nred,circle\nblue,square\nred,triangle\nblue,hexagon\n",
    );
    const parsed = parseQuestion("most common colour", tied);
    if (!parsed.ok) throw new Error(`abstained: ${parsed.reason}`);
    const r = executeQuery(parsed.query, tied);
    expect(r).toEqual({
      kind: "mode",
      column: "colour",
      value: "blue",
      count: 2,
      totalDistinct: 2,
      rowsMatched: 4,
      valuesUsed: 4,
    });
  });

  it("respects filters when finding the mode", () => {
    const r = ask("most common product in North");
    expect(r.kind).toBe("mode");
    if (r.kind === "mode") {
      // North rows are Widget A (twice) and Widget C (once).
      expect(r.value).toBe("Widget A");
      expect(r.count).toBe(2);
      expect(r.totalDistinct).toBe(2);
      expect(r.rowsMatched).toBe(3);
    }
  });

  it("reports a null mode when the column has no usable values", () => {
    const blank = parseCsv("a,b\n1,\n2,\n");
    const parsed = parseQuestion("most common b", blank);
    if (!parsed.ok) throw new Error(`abstained: ${parsed.reason}`);
    const r = executeQuery(parsed.query, blank);
    expect(r).toEqual({
      kind: "mode",
      column: "b",
      value: null,
      count: 0,
      totalDistinct: 0,
      rowsMatched: 2,
      valuesUsed: 0,
    });
  });
});

describe("executeQuery distinct count", () => {
  it("counts distinct values as a scalar, blanks excluded", () => {
    const r = ask("how many distinct regions");
    expect(r).toEqual({
      kind: "scalar",
      label: "distinct region values",
      value: 4,
      rowsMatched: 6,
      valuesUsed: 6,
    });
  });

  it("does not count a blank cell as a value", () => {
    const r = ask("how many distinct units");
    expect(r.kind).toBe("scalar");
    if (r.kind === "scalar") {
      // The blank-units row contributes no value; 5 distinct numbers remain.
      expect(r.value).toBe(5);
      expect(r.valuesUsed).toBe(5);
    }
  });

  it("respects filters when counting distinct values", () => {
    const r = ask("how many distinct products in North", SALES);
    expect(r.kind).toBe("scalar");
    if (r.kind === "scalar") {
      expect(r.value).toBe(2);
      expect(r.rowsMatched).toBe(3);
    }
  });
});

describe("executeQuery percentile", () => {
  it("returns the 90th percentile as a labelled scalar", () => {
    const r = ask("90th percentile of revenue");
    expect(r).toEqual({
      kind: "scalar",
      label: "90th percentile of revenue",
      // Sorted revenue: 0, 124.95, 149.97, 199.92, 240, 400 —
      // rank 0.9 * 5 = 4.5, halfway between 240 and 400.
      value: 320,
      rowsMatched: 6,
      valuesUsed: 6,
    });
  });

  it("interpolates the 75th percentile the same way as the quartiles", () => {
    const r = ask("75th percentile of revenue");
    expect(r.kind).toBe("scalar");
    if (r.kind === "scalar") {
      // Rank 0.75 * 5 = 3.75: 199.92 + 0.75 * (240 - 199.92).
      expect(r.value).toBeCloseTo(229.98, 10);
    }
  });

  it("answers the short p90 form and skips null values", () => {
    const r = ask("p50 salary", STAFF);
    expect(r).toEqual({
      kind: "scalar",
      label: "50th percentile of salary",
      value: 95000,
      rowsMatched: 3,
      valuesUsed: 3,
    });
  });

  it("respects filters when computing a percentile", () => {
    const r = ask("50th percentile of revenue in North");
    expect(r.kind).toBe("scalar");
    if (r.kind === "scalar") {
      // North revenue: 0, 149.97, 240 — the median is 149.97.
      expect(r.value).toBe(149.97);
      expect(r.rowsMatched).toBe(3);
    }
  });

  it("reports a null percentile when the matched rows have no usable values", () => {
    const sparse = parseCsv("a,b\n1,10\n2,NA\n3,30\n");
    const parsed = parseQuestion("90th percentile of b where a is 2", sparse);
    if (!parsed.ok) throw new Error(`abstained: ${parsed.reason}`);
    const r = executeQuery(parsed.query, sparse);
    expect(r).toEqual({
      kind: "scalar",
      label: "90th percentile of b",
      value: null,
      rowsMatched: 1,
      valuesUsed: 0,
    });
  });
});

describe("executeQuery trend", () => {
  const TREND = parseCsv(
    "date,region,revenue\n" +
      "2026-01-05,North,100\n" +
      "2026-01-20,South,200\n" +
      "2026-02-03,East,400\n" +
      "2026-02-10,West,100\n" +
      "2026-03-02,North,300\n" +
      "2026-03-15,East,300\n",
  );

  it("fits the least-squares slope over monthly totals", () => {
    const r = ask("revenue trend by month", TREND);
    expect(r.kind).toBe("trend");
    if (r.kind === "trend") {
      // Monthly totals 300, 500, 600: the slope is 150 per month.
      expect(r.periods.map((p) => p.label)).toEqual([
        "Jan 2026",
        "Feb 2026",
        "Mar 2026",
      ]);
      expect(r.periods.map((p) => p.value)).toEqual([300, 500, 600]);
      expect(r.slope).toBeCloseTo(150, 10);
      expect(r.direction).toBe("up");
      expect(r.rowsMatched).toBe(6);
    }
  });

  it("reports a flat series as flat, not as a tiny slope", () => {
    const flat = parseCsv(
      "date,revenue\n" +
        "2026-01-05,100\n" +
        "2026-02-03,101\n" +
        "2026-03-02,100\n",
    );
    const r = ask("revenue trend by month", flat);
    expect(r.kind).toBe("trend");
    if (r.kind === "trend") {
      expect(r.slope).toBeCloseTo(0, 10);
      expect(r.direction).toBe("flat");
    }
  });

  it("returns a null slope with a single period", () => {
    const one = parseCsv("date,revenue\n2026-01-05,100\n2026-01-20,200\n");
    const r = ask("revenue trend by month", one);
    expect(r.kind).toBe("trend");
    if (r.kind === "trend") {
      expect(r.periods).toHaveLength(1);
      expect(r.slope).toBeNull();
      expect(r.direction).toBeNull();
    }
  });

  it("skips a period with no usable values in the fit but still lists it", () => {
    const sparse = parseCsv(
      "date,revenue\n" +
        "2026-01-05,NA\n" +
        "2026-02-03,500\n" +
        "2026-03-02,600\n",
    );
    const r = ask("revenue trend by month", sparse);
    expect(r.kind).toBe("trend");
    if (r.kind === "trend") {
      expect(r.periods[0].value).toBeNull();
      expect(r.periods[0].rows).toBe(1);
      // The fit runs over Feb (x=1) and Mar (x=2): 600 - 500 = 100.
      expect(r.slope).toBeCloseTo(100, 10);
      expect(r.direction).toBe("up");
    }
  });

  it("ignores rows with no usable date", () => {
    const dateless = parseCsv(
      "date,revenue\n" +
        "2026-01-05,300\n" +
        "2026-02-03,500\n" +
        "2026-03-02,600\n" +
        ",999\n",
    );
    const r = ask("revenue trend by month", dateless);
    expect(r.kind).toBe("trend");
    if (r.kind === "trend") {
      expect(r.periods).toHaveLength(3);
      expect(r.slope).toBeCloseTo(150, 10);
      // The dateless row counts in rowsMatched but not in any period.
      expect(r.rowsMatched).toBe(4);
    }
  });

  it("trends an average as well as a total", () => {
    const r = ask("average revenue trend by month", TREND);
    expect(r.kind).toBe("trend");
    if (r.kind === "trend") {
      // Monthly averages 150, 250, 300: slope 75 per month.
      expect(r.periods.map((p) => p.value)).toEqual([150, 250, 300]);
      expect(r.slope).toBeCloseTo(75, 10);
      expect(r.direction).toBe("up");
    }
  });
});

describe("executeQuery missing values", () => {
  it("counts the missing rows of one column", () => {
    const r = ask("how many rows are missing units");
    expect(r).toEqual({
      kind: "missing",
      column: "units",
      entries: [{ column: "units", missing: 1, total: 6 }],
      headers: ["date", "region", "product", "units", "revenue"],
      rows: [],
      totalMatched: 0,
      limitedTo: undefined,
      listRows: false,
      rowsMatched: 6,
    });
  });

  it("reports a whole-sheet report with the worst column first", () => {
    const r = ask("which columns have missing values");
    expect(r.kind).toBe("missing");
    if (r.kind === "missing") {
      expect(r.column).toBeNull();
      expect(r.entries).toEqual([
        { column: "units", missing: 1, total: 6 },
        { column: "date", missing: 0, total: 6 },
        { column: "product", missing: 0, total: 6 },
        { column: "region", missing: 0, total: 6 },
        { column: "revenue", missing: 0, total: 6 },
      ]);
      expect(r.rowsMatched).toBe(6);
    }
  });

  it("lists the rows missing a column, in sheet order", () => {
    const r = ask("show rows missing units");
    expect(r.kind).toBe("missing");
    if (r.kind === "missing") {
      expect(r.listRows).toBe(true);
      expect(r.totalMatched).toBe(1);
      expect(r.rows).toEqual([
        { date: "2026-01-10", region: "North", product: "Widget A", units: "", revenue: "0.00" },
      ]);
    }
  });

  it("does not count a zero as missing", () => {
    const r = ask("how many rows are missing revenue");
    expect(r.kind).toBe("missing");
    if (r.kind === "missing") {
      expect(r.entries).toEqual([{ column: "revenue", missing: 0, total: 6 }]);
    }
  });

  it("counts over the filtered rows only", () => {
    const r = ask("how many rows are missing units in North");
    expect(r.kind).toBe("missing");
    if (r.kind === "missing") {
      // North has 3 rows; only the 2026-01-10 row is missing units.
      expect(r.entries).toEqual([{ column: "units", missing: 1, total: 3 }]);
      expect(r.rowsMatched).toBe(3);
    }
  });

  it("counts an NA marker as missing, like a blank", () => {
    const staff = parseCsv(
      "id,name,department,salary\n" +
        "1,Ada,Engineering,95000\n" +
        "2,Grace,Engineering,NA\n" +
        "3,Alan,Data,88000\n",
    );
    const parsed = parseQuestion("how many rows are missing salary", staff);
    if (!parsed.ok) throw new Error(`abstained: ${parsed.reason}`);
    const r = executeQuery(parsed.query, staff);
    expect(r.kind).toBe("missing");
    if (r.kind === "missing") {
      expect(r.entries).toEqual([{ column: "salary", missing: 1, total: 3 }]);
    }
  });
});
