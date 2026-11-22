import { describe, expect, it } from "vitest";
import { answerQuestion, composeAnswer, composeAbstention, formatNumber } from "../src/answer.js";
import { parseCsv } from "../src/csv.js";
import type { QueryResult } from "../src/engine.js";

const SALES = parseCsv(
  "date,region,product,units,revenue\n" +
    "2026-01-05,North,Widget A,12,240.00\n" +
    "2026-01-06,South,Widget B,8,199.92\n" +
    "2026-01-07,North,Widget C,3,149.97\n" +
    "2026-01-08,East,Widget A,20,400.00\n" +
    "2026-01-09,West,Widget B,5,124.95\n" +
    "2026-01-10,North,Widget A,,0.00\n",
);

describe("formatNumber", () => {
  it("adds thousands separators and trims trailing zeros", () => {
    expect(formatNumber(1114.84)).toBe("1,114.84");
    expect(formatNumber(400)).toBe("400");
    expect(formatNumber(174.945)).toBe("174.95");
  });
});

describe("composeAnswer scalars", () => {
  it("states a total with its row scope", () => {
    const r: QueryResult = {
      kind: "scalar",
      label: "total revenue",
      value: 1114.84,
      rowsMatched: 6,
      valuesUsed: 6,
    };
    expect(composeAnswer(r)).toBe("Total revenue is 1,114.84 (across 6 rows).");
  });

  it("reports a null aggregate as no usable values, not zero", () => {
    const r: QueryResult = {
      kind: "scalar",
      label: "total x",
      value: null,
      rowsMatched: 2,
      valuesUsed: 0,
    };
    expect(composeAnswer(r)).toMatch(/no usable values/);
    expect(composeAnswer(r)).not.toMatch(/is 0/);
  });

  it("counts with singular and zero forms", () => {
    const one: QueryResult = { kind: "scalar", label: "count", value: 1, rowsMatched: 1, valuesUsed: 1 };
    expect(composeAnswer(one)).toBe("There is 1 matching row.");
    const zero: QueryResult = { kind: "scalar", label: "count", value: 0, rowsMatched: 0, valuesUsed: 0 };
    expect(composeAnswer(zero)).toBe("No rows match.");
  });
});

describe("composeAnswer groups and rows", () => {
  it("lists groups largest first with row counts", () => {
    const r: QueryResult = {
      kind: "groups",
      groupBy: ["region"],
      column: "revenue",
      op: "sum",
      groups: [
        { key: "East", keys: ["East"], value: 400, count: 1 },
        { key: "North", keys: ["North"], value: 389.97, count: 3 },
      ],
      rowsMatched: 6,
      totalGroups: 4,
      limitedTo: 2,
    };
    const out = composeAnswer(r);
    expect(out).toContain("Top 2 of 4 groups:");
    expect(out).toContain("- East: 400 (1 row)");
    expect(out).toContain("- North: 389.97 (3 rows)");
  });

  it("says Bottom for a lowest-direction ranking", () => {
    const r: QueryResult = {
      kind: "groups",
      groupBy: ["product"],
      column: "revenue",
      op: "sum",
      groups: [
        { key: "Widget C", keys: ["Widget C"], value: 149.97, count: 1 },
        { key: "Widget B", keys: ["Widget B"], value: 324.87, count: 2 },
      ],
      rowsMatched: 6,
      totalGroups: 3,
      limitedTo: 2,
      direction: "lowest",
    };
    const out = composeAnswer(r);
    expect(out).toContain("Bottom 2 of 3 groups:");
    expect(out).not.toContain("Top 2");
    expect(out).toContain("- Widget C: 149.97 (1 row)");
  });

  it("names every group column in a multi-column answer", () => {
    const r: QueryResult = {
      kind: "groups",
      groupBy: ["region", "product"],
      column: "revenue",
      op: "sum",
      groups: [
        { key: "East · Widget A", keys: ["East", "Widget A"], value: 400, count: 1 },
        { key: "North · Widget A", keys: ["North", "Widget A"], value: 240, count: 2 },
      ],
      rowsMatched: 6,
      totalGroups: 5,
    };
    const out = composeAnswer(r);
    expect(out).toContain("Total revenue by region and product:");
    expect(out).toContain("- East · Widget A: 400 (1 row)");
    expect(out).toContain("- North · Widget A: 240 (2 rows)");
  });

  it("renders rows as a table with the shown/total scope", () => {
    const r: QueryResult = {
      kind: "rows",
      headers: ["region", "revenue"],
      rows: [{ region: "North", revenue: "240.00" }],
      totalMatched: 3,
      limitedTo: 1,
    };
    const out = composeAnswer(r);
    expect(out).toContain("Showing 1 of 3 matching rows:");
    expect(out).toContain("| region | revenue |");
    expect(out).toContain("| North | 240.00 |");
  });

  it("names the sort in a sorted listing's scope line", () => {
    const r: QueryResult = {
      kind: "rows",
      headers: ["region", "revenue"],
      rows: [{ region: "East", revenue: "400.00" }],
      totalMatched: 6,
      limitedTo: 1,
      sortedBy: { column: "revenue", direction: "desc" },
    };
    const out = composeAnswer(r);
    expect(out).toContain("Showing 1 of 6 matching rows, sorted by revenue (descending):");
  });

  it("answers a sorted question end to end, highest revenue first", () => {
    const out = answerQuestion("show rows sorted by revenue descending", SALES);
    expect(out).toContain("6 matching rows, sorted by revenue (descending):");
    // The table's first data row is the 400.00 sale, not the sheet's
    // first row — substring order in the answer proves the sort.
    // (Numeric cells are formatted, so 400.00 prints as 400.)
    const firstRow = out.indexOf("| 2026-01-08 | East | Widget A | 20 | 400 |");
    const secondRow = out.indexOf("| 2026-01-05 | North | Widget A | 12 | 240 |");
    expect(firstRow).toBeGreaterThan(-1);
    expect(secondRow).toBeGreaterThan(-1);
    expect(firstRow).toBeLessThan(secondRow);
  });

  it("names the winning group end to end", () => {
    const out = answerQuestion("which region has the highest total revenue", SALES);
    expect(out).toBe("East has the highest total revenue: 400 (of 4 regions).");
  });

  it("states the baseline in an above-average answer", () => {
    const r: QueryResult = {
      kind: "aboveBelow",
      column: "revenue",
      direction: "above",
      baseline: "average",
      threshold: 185.81,
      headers: ["region", "revenue"],
      rows: [{ region: "East", revenue: "400.00" }],
      totalMatched: 3,
      rowsMatched: 6,
    };
    const out = composeAnswer(r, SALES);
    expect(out).toContain("3 rows have revenue above the average of 185.81:");
    expect(out).toContain("| East | 400 |");
  });

  it("says plainly when no row is on the asked side", () => {
    const r: QueryResult = {
      kind: "aboveBelow",
      column: "revenue",
      direction: "above",
      baseline: "average",
      threshold: 185.81,
      headers: ["region", "revenue"],
      rows: [],
      totalMatched: 0,
      rowsMatched: 6,
    };
    expect(composeAnswer(r, SALES)).toBe(
      "No rows have revenue above the average of 185.81.",
    );
  });

  it("says plainly when the column has no usable value", () => {
    const r: QueryResult = {
      kind: "aboveBelow",
      column: "score",
      direction: "above",
      baseline: "average",
      threshold: null,
      headers: ["name", "score"],
      rows: [],
      totalMatched: 0,
      rowsMatched: 2,
    };
    expect(composeAnswer(r)).toBe(
      "I could not compare score to its average — none of the 2 matching rows has a usable value.",
    );
  });

  it("answers an above-average question end to end", () => {
    const out = answerQuestion("rows with revenue above average", SALES);
    expect(out).toContain("3 rows have revenue above the average of 185.81:");
    expect(out).toContain("| 2026-01-08 | East | Widget A | 20 | 400 |");
  });
});

describe("composeAnswer group extreme", () => {
  it("names one winner with its value and the group count", () => {
    const r: QueryResult = {
      kind: "groupextreme",
      groupBy: "region",
      column: "revenue",
      op: "sum",
      direction: "highest",
      winners: [{ key: "East", value: 400, count: 1 }],
      groups: [
        { key: "East", value: 400, count: 1, valuesUsed: 1 },
        { key: "North", value: 389.97, count: 3, valuesUsed: 3 },
      ],
      totalGroups: 4,
      rowsMatched: 6,
    };
    expect(composeAnswer(r)).toBe("East has the highest total revenue: 400 (of 4 regions).");
  });

  it("names every tied winner with 'each'", () => {
    const r: QueryResult = {
      kind: "groupextreme",
      groupBy: "region",
      column: "revenue",
      op: "sum",
      direction: "highest",
      winners: [
        { key: "North", value: 100, count: 1 },
        { key: "South", value: 100, count: 1 },
      ],
      groups: [
        { key: "North", value: 100, count: 1, valuesUsed: 1 },
        { key: "South", value: 100, count: 1, valuesUsed: 1 },
        { key: "East", value: 50, count: 1, valuesUsed: 1 },
      ],
      totalGroups: 3,
      rowsMatched: 3,
    };
    expect(composeAnswer(r)).toBe(
      "North and South tie for the highest total revenue: 100 each (of 3 regions).",
    );
  });

  it("says how many of the winner's rows had a value when some were blank", () => {
    const r: QueryResult = {
      kind: "groupextreme",
      groupBy: "department",
      column: "salary",
      op: "median",
      direction: "highest",
      winners: [{ key: "Engineering", value: 96500, count: 3 }],
      groups: [
        { key: "Engineering", value: 96500, count: 3, valuesUsed: 2 },
        { key: "Data", value: 88000, count: 1, valuesUsed: 1 },
      ],
      totalGroups: 2,
      rowsMatched: 4,
    };
    expect(composeAnswer(r)).toBe(
      "Engineering has the highest median salary: 96,500 (2 of 3 rows in Engineering had a value; of 2 departments).",
    );
  });

  it("says plainly when no group had a usable value", () => {
    const r: QueryResult = {
      kind: "groupextreme",
      groupBy: "region",
      column: "revenue",
      op: "sum",
      direction: "highest",
      winners: [],
      groups: [
        { key: "North", value: null, count: 1, valuesUsed: 0 },
        { key: "South", value: null, count: 1, valuesUsed: 0 },
      ],
      totalGroups: 2,
      rowsMatched: 2,
    };
    const out = composeAnswer(r);
    expect(out).toMatch(/No group had a usable value for revenue/);
    expect(out).not.toMatch(/is 0/);
  });

  it("says plainly when no rows match", () => {
    const r: QueryResult = {
      kind: "groupextreme",
      groupBy: "region",
      column: "revenue",
      op: "sum",
      direction: "highest",
      winners: [],
      groups: [],
      totalGroups: 0,
      rowsMatched: 0,
    };
    expect(composeAnswer(r)).toBe("No rows match.");
  });

  it("names groups that had no usable value alongside the winner", () => {
    const r: QueryResult = {
      kind: "groupextreme",
      groupBy: "region",
      column: "revenue",
      op: "sum",
      direction: "lowest",
      winners: [{ key: "East", value: 50, count: 1 }],
      groups: [
        { key: "East", value: 50, count: 1, valuesUsed: 1 },
        { key: "North", value: 100, count: 1, valuesUsed: 1 },
        { key: "South", value: null, count: 1, valuesUsed: 0 },
      ],
      totalGroups: 3,
      rowsMatched: 3,
    };
    expect(composeAnswer(r)).toBe(
      "East has the lowest total revenue: 50 (of 3 regions). 1 region had no usable revenue.",
    );
  });
});

describe("composeAbstention", () => {
  it("states the reason and the available columns", () => {
    const out = composeAbstention("no column named in the question", ["date", "region"]);
    expect(out).toBe(
      "I can't answer that from this data: no column named in the question. Columns available: date, region.",
    );
  });

  it("does not list the columns twice when the reason already names them", () => {
    const out = composeAbstention(
      "no column named in the question — columns are: date, region",
      ["date", "region"],
    );
    expect(out).toBe(
      "I can't answer that from this data: no column named in the question — columns are: date, region.",
    );
    expect(out).not.toContain("Columns available:");
  });
});

describe("answerQuestion end to end", () => {
  it("answers a total from the bundled-style sheet", () => {
    expect(answerQuestion("total revenue", SALES)).toBe(
      "Total revenue is 1,114.84 (across 6 rows).",
    );
  });

  it("answers a total filtered by a cross-column comparison", () => {
    expect(answerQuestion("total revenue where revenue is greater than units", SALES)).toBe(
      "Total revenue is 1,114.84 (across 5 rows).",
    );
  });

  it("abstains honestly on a cross-column comparison it cannot make", () => {
    expect(answerQuestion("how many rows where region is greater than product", SALES)).toBe(
      "I can't answer that from this data: cannot compare \"region\" (text) with \"product\" (text) — a cross-column comparison needs two numbers or two dates. " +
        "Columns available: date, region, product, units, revenue.",
    );
  });

  it("answers a grouped question", () => {
    const out = answerQuestion("total revenue by region", SALES);
    expect(out).toContain("Total revenue by region:");
    expect(out).toContain("- East: 400 (1 row)");
  });

  it("abstains honestly on an unanswerable question", () => {
    const out = answerQuestion("total profit", SALES);
    expect(out).toBe(
      "I can't answer that from this data: no column named in the question — columns are: date, region, product, units, revenue.",
    );
  });

  it("formats numeric cells in row answers like scalar answers", () => {
    // Regression: the eval caught row tables showing raw "98000"
    // while scalar answers print "98,000". With the sheet available,
    // numeric columns are formatted; without it they stay raw.
    const out = answerQuestion("highest revenue", SALES);
    expect(out).toContain("Widget A");
    expect(out).toContain("| 400 |");
    expect(out).not.toContain("400.00");
  });

  it("answers a filtered count", () => {
    expect(answerQuestion("how many rows where region is North", SALES)).toBe(
      "There are 3 matching rows.",
    );
  });

  it("answers a percentile question with the ordinal label", () => {
    expect(answerQuestion("90th percentile of revenue", SALES)).toBe(
      "90th percentile of revenue is 320 (across 6 rows).",
    );
  });

  it("says plainly when a percentile has no usable values", () => {
    const sparse = parseCsv("a,b\n1,10\n2,NA\n3,30\n");
    expect(answerQuestion("90th percentile of b where a is 2", sparse)).toBe(
      "I could not compute the 90th percentile of b — the column has no usable values in the 1 matching row.",
    );
  });

  it("answers a rank question with the value and how many rows hold it", () => {
    expect(answerQuestion("second highest revenue", SALES)).toBe(
      "The 2nd highest revenue is 240 (1 row holds it, out of 6 distinct values).",
    );
  });

  it("says how many rows share a tied rank value", () => {
    const tied = parseCsv("x,y\n1,10\n2,10\n3,20\n4,20\n5,20\n6,30\n");
    expect(answerQuestion("second highest y", tied)).toBe(
      "The 2nd highest y is 20 (3 rows hold it, out of 3 distinct values).",
    );
  });

  it("says plainly when a rank runs past the end", () => {
    expect(answerQuestion("7th highest revenue", SALES)).toBe(
      "The 7th highest revenue does not exist — there are only 6 distinct revenue values in the 6 matching rows.",
    );
  });

  it("says plainly when a rank has no usable values", () => {
    const sparse = parseCsv("a,b\n1,10\n2,NA\n3,30\n");
    expect(answerQuestion("2nd highest b where a is 2", sparse)).toBe(
      "I could not find the 2nd highest b — the column has no usable values in the 1 matching row.",
    );
  });

  it("answers a group-rank question with the holding group", () => {
    // Region totals: North 389.97, South 199.92, East 400, West
    // 124.95 — the 2nd highest is North's 389.97.
    expect(answerQuestion("second highest total revenue by region", SALES)).toBe(
      "The 2nd highest total revenue by region is 389.97 (North holds it (3 rows), out of 4 distinct total revenue values).",
    );
  });

  it("answers the 'which group has the ...' phrasing of a group rank", () => {
    expect(answerQuestion("which region has the second highest total revenue", SALES)).toBe(
      "The 2nd highest total revenue by region is 389.97 (North holds it (3 rows), out of 4 distinct total revenue values).",
    );
  });

  it("names tied groups in a group-rank answer", () => {
    const tied = parseCsv("region,revenue\nNorth,100\nSouth,100\nEast,50\n");
    expect(answerQuestion("first highest total revenue by region", tied)).toBe(
      "The 1st highest total revenue by region is 100 (North and South tie for it (2 rows between them), out of 2 distinct total revenue values).",
    );
  });

  it("says plainly when a group rank runs past the end", () => {
    expect(answerQuestion("5th highest total revenue by region", SALES)).toBe(
      "The 5th highest total revenue by region does not exist — there are only 4 distinct total revenue values across 4 regions in the 6 matching rows.",
    );
  });

  it("says plainly when no group in a group rank has a usable value", () => {
    const sparse = parseCsv("a,b\n1,10\n2,NA\n3,30\n");
    expect(answerQuestion("2nd highest total b by a where a is 2", sparse)).toBe(
      "I could not find the 2nd highest total b by a — no group had a usable value for b in the 1 matching row.",
    );
  });

  it("names the coverage when some rows had no usable value", () => {
    const staff = parseCsv(
      "id,name,department,salary,start_date,remote\n" +
        "1,Ada,Engineering,95000,2024-03-01,true\n" +
        "2,Grace,Engineering,98000,2023-07-15,true\n" +
        "3,Alan,Data,88000,2025-01-20,false\n" +
        "4,Katherine,Data,91000,2024-11-04,true\n" +
        "5,Edsger,Engineering,NA,2022-05-30,false\n",
    );
    expect(answerQuestion("second highest salary", staff)).toBe(
      "The 2nd highest salary is 95,000 (1 row holds it, out of 4 distinct values; 4 of 5 had a value).",
    );
  });

  it("answers a between-range total", () => {
    expect(answerQuestion("total revenue where revenue between 100 and 200", SALES)).toBe(
      "Total revenue is 474.84 (across 3 rows).",
    );
  });
});

describe("composeAnswer time groups", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,12,240.00\n" +
      "2026-01-20,South,Widget B,8,199.92\n" +
      "2026-02-03,East,Widget A,20,400.00\n" +
      "2026-02-10,West,Widget B,5,124.95\n" +
      "2026-03-02,North,Widget C,15,449.85\n" +
      "2026-03-15,East,Widget B,9,224.91\n",
  );

  it("names the period, not the raw date column", () => {
    const answer = answerQuestion("total revenue by month", MONTHLY);
    expect(answer).toMatch(/^Total revenue by month:/);
    expect(answer).toContain("- Jan 2026: 439.92 (2 rows)");
    expect(answer).toContain("- Mar 2026: 674.76 (2 rows)");
    expect(answer).not.toContain("by date");
  });

  it("counts months in the top-N scope line", () => {
    const answer = answerQuestion("top 2 months by revenue", MONTHLY);
    expect(answer).toMatch(/^Top 2 of 3 months:/);
    expect(answer).toContain("- Mar 2026: 674.76 (2 rows)");
  });

  it("says Bottom for a bottom-N question end to end", () => {
    const answer = answerQuestion("bottom 2 months by revenue", MONTHLY);
    expect(answer).toMatch(/^Bottom 2 of 3 months:/);
    // Jan 439.92 is the lowest month, Feb 524.95 second; Mar is cut.
    expect(answer).toContain("- Jan 2026: 439.92 (2 rows)");
    expect(answer).toContain("- Feb 2026: 524.95 (2 rows)");
    expect(answer).not.toContain("Mar 2026");
  });

  it("keeps plain group answers unchanged", () => {
    const answer = answerQuestion("total revenue by region", MONTHLY);
    expect(answer).toMatch(/^Total revenue by region:/);
  });
});

describe("composeAnswer correlation", () => {
  it("states r with a strength word and the pair count", () => {
    // SALES fixture: 5 paired rows, r ≈ 0.98.
    const answer = answerQuestion("correlation between revenue and units", SALES);
    expect(answer).toBe(
      "The correlation between revenue and units is 0.98 (strong positive) across 5 paired rows.",
    );
  });

  it("labels a moderate negative correlation", () => {
    const result: QueryResult = {
      kind: "correlation",
      columnA: "id",
      columnB: "salary",
      value: -0.6459,
      pairs: 4,
      rowsMatched: 5,
    };
    expect(composeAnswer(result)).toBe(
      "The correlation between id and salary is -0.65 (moderate negative) across 4 paired rows.",
    );
  });

  it("calls a near-zero correlation negligible", () => {
    const result: QueryResult = {
      kind: "correlation",
      columnA: "a",
      columnB: "b",
      value: 0.03,
      pairs: 10,
      rowsMatched: 10,
    };
    expect(composeAnswer(result)).toContain("(negligible — essentially no linear relationship)");
  });

  it("says plainly when too few pairs exist", () => {
    const result: QueryResult = {
      kind: "correlation",
      columnA: "a",
      columnB: "b",
      value: null,
      pairs: 1,
      rowsMatched: 4,
    };
    expect(composeAnswer(result)).toMatch(
      /could not compute the correlation between a and b — only 1 of the 4 matching rows has values in both columns/,
    );
  });

  it("says plainly when a column is constant", () => {
    const result: QueryResult = {
      kind: "correlation",
      columnA: "a",
      columnB: "b",
      value: null,
      pairs: 3,
      rowsMatched: 3,
    };
    expect(composeAnswer(result)).toMatch(/one of the columns is constant/);
  });
});

describe("composeAnswer comparison", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,10,200.00\n" +
      "2026-01-12,South,Widget B,5,124.95\n" +
      "2026-02-03,North,Widget B,12,299.88\n" +
      "2026-02-10,South,Widget A,6,120.00\n" +
      "2026-03-02,North,Widget C,3,134.97\n",
  );

  it("states growth with the delta and percent change", () => {
    expect(answerQuestion("compare revenue Jan 2026 vs Feb 2026", MONTHLY)).toBe(
      "Total revenue grew from 324.95 in Jan 2026 to 419.88 in Feb 2026 (+94.93, +29.21%).",
    );
  });

  it("states a fall with negative figures", () => {
    expect(answerQuestion("revenue change from February to March", MONTHLY)).toBe(
      "Total revenue fell from 419.88 in Feb 2026 to 134.97 in Mar 2026 (-284.91, -67.86%).",
    );
  });

  it("says so plainly when the totals are equal", () => {
    const flat = parseCsv(
      "date,product,revenue\n" +
        "2026-01-05,Widget A,200\n" +
        "2026-02-03,Widget B,200\n",
    );
    expect(answerQuestion("compare revenue Jan vs Feb", flat)).toBe(
      "Total revenue was unchanged at 200 in both Jan 2026 and Feb 2026.",
    );
  });

  it("compares row counts", () => {
    expect(answerQuestion("compare rows in Jan vs Mar", MONTHLY)).toBe(
      "Row count fell from 2 in Jan 2026 to 1 in Mar 2026 (-1, -50%).",
    );
  });

  it("explains when a period has no rows instead of inventing a comparison", () => {
    expect(answerQuestion("compare revenue Feb 2026 vs Apr 2026", MONTHLY)).toBe(
      "I could not compare the total revenue — Apr 2026 has no rows, so there is nothing to compare against.",
    );
  });

  it("reports the delta without a percent when the baseline is zero", () => {
    const zero = parseCsv(
      "date,product,revenue\n" +
        "2026-01-05,Widget A,0\n" +
        "2026-02-03,Widget B,300\n",
    );
    expect(answerQuestion("compare revenue Jan vs Feb", zero)).toBe(
      "Total revenue grew from 0 in Jan 2026 to 300 in Feb 2026 (+300). No percent change is possible — the Jan 2026 baseline was 0.",
    );
  });
});

describe("composeAnswer head-to-head", () => {
  it("names the higher side with the difference and percent", () => {
    expect(answerQuestion("compare total revenue in North vs South", SALES)).toBe(
      "Total revenue was higher in North (389.97) than in South (199.92) by 190.05 (95.06% higher).",
    );
  });

  it("names the higher side whichever order the question asks", () => {
    expect(answerQuestion("compare total revenue in South vs North", SALES)).toBe(
      "Total revenue was higher in North (389.97) than in South (199.92) by 190.05 (95.06% higher).",
    );
  });

  it("compares averages and row counts", () => {
    expect(answerQuestion("compare average revenue in North vs South", SALES)).toBe(
      "Average revenue was higher in South (199.92) than in North (129.99) by 69.93 (53.8% higher).",
    );
    expect(answerQuestion("compare rows in North vs East", SALES)).toBe(
      "Row count was higher in North (3) than in East (1) by 2 (200% higher).",
    );
  });

  it("says so plainly when the sides tie", () => {
    const tied = parseCsv(
      "region,product,revenue\n" + "North,Widget A,100\n" + "South,Widget B,100\n",
    );
    expect(answerQuestion("compare total revenue in North vs South", tied)).toBe(
      "Total revenue was the same in North and South at 100.",
    );
  });

  it("flags a side where some rows had no usable value", () => {
    // North units are 12, 3 and one blank — the average is over 2 values, not 3 rows.
    expect(answerQuestion("compare average units in North vs South", SALES)).toBe(
      "Average units was higher in South (8) than in North (7.5) by 0.5 (6.67% higher). (2 of 3 had a value in North)",
    );
  });

  it("explains when a side has no usable values instead of inventing a comparison", () => {
    const blank = parseCsv(
      "region,product,revenue\n" + "North,Widget A,\n" + "South,Widget B,100\n",
    );
    expect(answerQuestion("compare total revenue in North vs South", blank)).toBe(
      "I could not compare the total revenue — North has 1 row but none with a usable value, so there is nothing to compare against.",
    );
  });

  it("reports the difference without a percent when the lower side is zero", () => {
    const zero = parseCsv(
      "region,product,revenue\n" + "North,Widget A,0\n" + "South,Widget B,100\n",
    );
    expect(answerQuestion("compare total revenue in North vs South", zero)).toBe(
      "Total revenue was higher in South (100) than in North (0) by 100. No percent is possible — the North total revenue was 0.",
    );
  });
});

describe("composeAnswer share", () => {
  it("states a value share with the subset and the whole-sheet total", () => {
    const answer = answerQuestion("what share of revenue is North", SALES);
    // North 389.97 of 1,114.84 = 34.98%.
    expect(answer).toBe(
      "Region is North accounts for 34.98% of total revenue " +
        "(389.97 of 1,114.84, from 3 of 6 rows).",
    );
  });

  it("states a row-count share", () => {
    const answer = answerQuestion("what share of rows are in North", SALES);
    expect(answer).toBe("3 of 6 rows (50%) match region is North.");
  });

  it("says so when the whole-sheet total is zero", () => {
    const zeros = parseCsv("a,b\n1,0\n2,0\n");
    const answer = answerQuestion("what share of b where a is 1", zeros);
    expect(answer).toBe(
      "I could not compute the share of total b — the total is 0, " +
        "so there is nothing to share out.",
    );
  });

  it("flags a subset where some rows had no usable value", () => {
    const answer = answerQuestion("what share of units is North", SALES);
    // North units 15 of 48 = 31.25%; only 2 of the 3 North rows had a units value.
    expect(answer).toBe(
      "Region is North accounts for 31.25% of total units " +
        "(15 of 48, from 3 of 6 rows, 2 of 3 had a value).",
    );
  });

  it("names both conditions of a compound filter", () => {
    const answer = answerQuestion(
      "what share of revenue where region is North and product is Widget A",
      SALES,
    );
    // North + Widget A: 240 of 1,114.84 = 21.53%, from 2 of 6 rows.
    expect(answer).toBe(
      "Region is North and product is Widget A accounts for 21.53% of total revenue " +
        "(240 of 1,114.84, from 2 of 6 rows).",
    );
  });

  it("renders a comparison operator in words in a row-count share", () => {
    const answer = answerQuestion(
      "what share of rows where region is North and revenue > 100",
      SALES,
    );
    expect(answer).toBe(
      "2 of 6 rows (33.33%) match region is North and revenue is greater than 100.",
    );
  });

  it("renders a cross-column filter in words in a row-count share", () => {
    const answer = answerQuestion(
      "what share of rows where revenue is greater than units",
      SALES,
    );
    expect(answer).toBe("5 of 6 rows (83.33%) match revenue is greater than units.");
  });

  it("renders a comparison operator in words in a value share", () => {
    const answer = answerQuestion(
      "what share of revenue where revenue > 100 and region is North",
      SALES,
    );
    // North rows above 100: 240.00 + 149.97 = 389.97 of 1,114.84 = 34.98%.
    expect(answer).toBe(
      "Revenue is greater than 100 and region is North accounts for 34.98% of total revenue " +
        "(389.97 of 1,114.84, from 2 of 6 rows).",
    );
  });

  it("states a value share over an or subset", () => {
    const answer = answerQuestion("what share of revenue is North or South", SALES);
    // North + South 589.89 of 1,114.84 = 52.91%, from 4 of 6 rows.
    expect(answer).toBe(
      "Region is North or region is South accounts for 52.91% of total revenue " +
        "(589.89 of 1,114.84, from 4 of 6 rows).",
    );
  });

  it("states a row-count share over an or subset", () => {
    const answer = answerQuestion("what share of rows are in North or South", SALES);
    expect(answer).toBe(
      "4 of 6 rows (66.67%) match region is North or region is South.",
    );
  });

  it("parenthesises a multi-filter or branch in a share", () => {
    const answer = answerQuestion(
      "what share of revenue where region is North or South and product is Widget A",
      SALES,
    );
    // (North) or (South and Widget A): North 389.97, no South Widget A.
    expect(answer).toBe(
      "Region is North or (region is South and product is Widget A) accounts for " +
        "34.98% of total revenue (389.97 of 1,114.84, from 3 of 6 rows).",
    );
  });

  it("abstains when an or share spans two columns", () => {
    const answer = answerQuestion("what share of revenue is North or Widget A", SALES);
    expect(answer).toMatch(/needs one column/);
  });
});

describe("composeAnswer distribution", () => {
  it("renders the bins as an ASCII histogram with a scope line", () => {
    const answer = answerQuestion("distribution of revenue", SALES);
    expect(answer).toContain("Distribution of revenue (6 values across 6 rows):");
    expect(answer).toContain("0–66.67");
    expect(answer).toContain("133.33–200");
    expect(answer).toContain("333.33–400");
  });

  it("says so when the column has no usable values", () => {
    expect(answerQuestion("distribution of units where units > 100", SALES)).toBe(
      "I could not show the distribution of units — none of the 0 matching rows has a usable value.",
    );
  });
});

describe("composeAnswer distinct values", () => {
  it("lists distinct values most frequent first with row counts", () => {
    expect(answerQuestion("list unique regions", SALES)).toBe(
      "Distinct region (4 values):\n" +
        "- North: 3 rows\n" +
        "- East: 1 row\n" +
        "- South: 1 row\n" +
        "- West: 1 row",
    );
  });

  it("says so when no rows match the filter", () => {
    expect(answerQuestion("list unique products where region is Atlantis", SALES)).toBe(
      "No rows match.",
    );
  });
});

describe("composeAnswer mode", () => {
  it("names the most common value, its count and the distinct total", () => {
    expect(answerQuestion("most common region", SALES)).toBe(
      "The most common region is North (3 of 6 rows, out of 4 distinct values).",
    );
  });

  it("says so when the column has no usable values", () => {
    expect(answerQuestion("most common units where units > 100", SALES)).toBe(
      "I could not find the most common units — the column has no usable values in the 0 matching rows.",
    );
  });

  it("renders a distinct count as a scalar answer", () => {
    expect(answerQuestion("how many distinct regions", SALES)).toBe(
      "Distinct region values is 4 (across 6 rows).",
    );
  });
});

describe("composeAnswer trend", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,10,200.00\n" +
      "2026-01-12,South,Widget B,5,124.95\n" +
      "2026-01-20,East,Widget A,8,160.00\n" +
      "2026-01-28,West,Widget C,4,179.96\n" +
      "2026-02-03,North,Widget B,12,299.88\n" +
      "2026-02-10,South,Widget A,6,120.00\n" +
      "2026-02-15,East,Widget C,7,314.93\n" +
      "2026-02-22,West,Widget A,9,180.00\n" +
      "2026-03-02,North,Widget C,3,134.97\n" +
      "2026-03-09,South,Widget A,15,300.00\n" +
      "2026-03-16,East,Widget B,10,249.90\n" +
      "2026-03-25,West,Widget B,6,149.94\n",
  );

  it("states the slope, the span and the first/last values", () => {
    expect(answerQuestion("revenue trend by month", MONTHLY)).toBe(
      "Total revenue trended up by about 84.95 per month over 3 months " +
        "(from 664.91 in Jan 2026 to 834.81 in Mar 2026).",
    );
  });

  it("trends an average and names a period with no usable values", () => {
    const staff = parseCsv(
      "id,name,department,salary,start_date,remote\n" +
        "1,Ada,Engineering,95000,2024-03-01,true\n" +
        "2,Grace,Engineering,98000,2023-07-15,true\n" +
        "3,Alan,Data,88000,2025-01-20,false\n" +
        "4,Katherine,Data,91000,2024-11-04,true\n" +
        "5,Edsger,Engineering,NA,2022-05-30,false\n",
    );
    expect(answerQuestion("average salary trend by year", staff)).toBe(
      "Average salary trended down by about 5,000 per year over 3 years " +
        "(from 98,000 in 2023 to 88,000 in 2025). " +
        "2022 has no usable values and is not in the trend.",
    );
  });

  it("calls a near-zero slope roughly flat", () => {
    const flat = parseCsv(
      "date,revenue\n2026-01-05,100\n2026-02-03,101\n2026-03-02,100\n",
    );
    expect(answerQuestion("revenue trend by month", flat)).toBe(
      "Total revenue was roughly flat by month (about 0 per month) " +
        "across 3 months, from 100 in Jan 2026 to 100 in Mar 2026.",
    );
  });

  it("says so plainly when one period cannot make a line", () => {
    const one = parseCsv("date,revenue\n2026-01-05,100\n2026-01-20,200\n");
    expect(answerQuestion("revenue trend by month", one)).toBe(
      "I could not compute the trend of total revenue by month — " +
        "only Jan 2026 has a usable value, so there is no line to fit.",
    );
  });

  it("says so plainly when no matching row has a usable date", () => {
    // A column of all-blank dates infers as "empty", not "date", so
    // the parser abstains there — the engine branch is reached when
    // the date column exists but the filter keeps only dateless rows.
    const mixed = parseCsv(
      "date,region,revenue\n" +
        ",North,100\n" +
        ",North,200\n" +
        "2026-01-05,South,300\n" +
        "2026-02-03,South,500\n",
    );
    expect(
      answerQuestion("revenue trend by month where region is North", mixed),
    ).toBe(
      "I could not compute the trend of total revenue by month — " +
        "none of the 2 matching rows has a usable date.",
    );
  });
});

describe("composeAnswer cumulative", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,10,200.00\n" +
      "2026-01-12,South,Widget B,5,124.95\n" +
      "2026-01-20,East,Widget A,8,160.00\n" +
      "2026-01-28,West,Widget C,4,179.96\n" +
      "2026-02-03,North,Widget B,12,299.88\n" +
      "2026-02-10,South,Widget A,6,120.00\n" +
      "2026-02-15,East,Widget C,7,314.93\n" +
      "2026-02-22,West,Widget A,9,180.00\n" +
      "2026-03-02,North,Widget C,3,134.97\n" +
      "2026-03-09,South,Widget A,15,300.00\n" +
      "2026-03-16,East,Widget B,10,249.90\n" +
      "2026-03-25,West,Widget B,6,149.94\n",
  );

  it("states the final total and the running total after each period", () => {
    expect(answerQuestion("cumulative revenue by month", MONTHLY)).toBe(
      "Total revenue by month reached 2,414.53 by Mar 2026 " +
        "(Jan 2026: 664.91; Feb 2026: 1,579.72; Mar 2026: 2,414.53).",
    );
  });

  it("names a period with no usable values instead of showing zero", () => {
    const staff = parseCsv(
      "id,name,department,salary,start_date,remote\n" +
        "1,Ada,Engineering,95000,2024-03-01,true\n" +
        "2,Grace,Engineering,98000,2023-07-15,true\n" +
        "3,Alan,Data,88000,2025-01-20,false\n" +
        "4,Katherine,Data,91000,2024-11-04,true\n" +
        "5,Edsger,Engineering,NA,2022-05-30,false\n",
    );
    expect(answerQuestion("cumulative salary by year", staff)).toBe(
      "Total salary by year reached 372,000 by 2025 " +
        "(2022: no usable values; 2023: 98,000; 2024: 284,000; 2025: 372,000). " +
        "2022 has no usable values and adds nothing to the total.",
    );
  });

  it("says so plainly when no matching row has a usable date", () => {
    const mixed = parseCsv(
      "date,region,revenue\n" +
        ",North,100\n" +
        ",North,200\n" +
        "2026-01-05,South,300\n" +
        "2026-02-03,South,500\n",
    );
    expect(
      answerQuestion("cumulative revenue by month where region is North", mixed),
    ).toBe(
      "I could not compute the running total of revenue by month — " +
        "none of the 2 matching rows has a usable date.",
    );
  });
});

describe("composeAnswer period change", () => {
  const MONTHLY = parseCsv(
    "date,region,product,units,revenue\n" +
      "2026-01-05,North,Widget A,10,200.00\n" +
      "2026-01-12,South,Widget B,5,124.95\n" +
      "2026-01-20,East,Widget A,8,160.00\n" +
      "2026-01-28,West,Widget C,4,179.96\n" +
      "2026-02-03,North,Widget B,12,299.88\n" +
      "2026-02-10,South,Widget A,6,120.00\n" +
      "2026-02-15,East,Widget C,7,314.93\n" +
      "2026-02-22,West,Widget A,9,180.00\n" +
      "2026-03-02,North,Widget C,3,134.97\n" +
      "2026-03-09,South,Widget A,15,300.00\n" +
      "2026-03-16,East,Widget B,10,249.90\n" +
      "2026-03-25,West,Widget B,6,149.94\n",
  );

  it("lists each period's change with the biggest rise and fall", () => {
    expect(answerQuestion("revenue change by month", MONTHLY)).toBe(
      "Total revenue by month changed: Feb 2026 rose by 249.9 (+37.58%) vs Jan 2026; " +
        "Mar 2026 fell by 80 (-8.74%) vs Feb 2026. " +
        "Biggest rise: Feb 2026 (+249.9, +37.58%). " +
        "Biggest fall: Mar 2026 (-80, -8.74%).",
    );
  });

  it("reads an unchanged period as unchanged, not as no change", () => {
    expect(answerQuestion("units change by month", MONTHLY)).toBe(
      "Total units by month changed: Feb 2026 rose by 7 (+25.93%) vs Jan 2026; " +
        "Mar 2026 was unchanged at 34 vs Feb 2026. " +
        "Biggest rise: Feb 2026 (+7, +25.93%).",
    );
  });

  it("names a period with no usable values instead of skipping it silently", () => {
    const staff = parseCsv(
      "id,name,department,salary,start_date,remote\n" +
        "1,Ada,Engineering,95000,2024-03-01,true\n" +
        "2,Grace,Engineering,98000,2023-07-15,true\n" +
        "3,Alan,Data,88000,2025-01-20,false\n" +
        "4,Katherine,Data,91000,2024-11-04,true\n" +
        "5,Edsger,Engineering,NA,2022-05-30,false\n",
    );
    expect(answerQuestion("salary change by year", staff)).toBe(
      "Total salary by year changed: 2024 rose by 88,000 (+89.8%) vs 2023; " +
        "2025 fell by 98,000 (-52.69%) vs 2024. " +
        "2022 has no usable values and is skipped in the changes. " +
        "Biggest rise: 2024 (+88,000, +89.8%). " +
        "Biggest fall: 2025 (-98,000, -52.69%).",
    );
  });

  it("says so plainly when one period cannot make a change", () => {
    const one = parseCsv("date,revenue\n2026-01-05,100\n2026-01-20,200\n");
    expect(answerQuestion("revenue change by month", one)).toBe(
      "I could not compute the change in total revenue by month — " +
        "only Jan 2026 has a usable value, so there is no previous period to compare against.",
    );
  });

  it("says so plainly when no matching row has a usable date", () => {
    const mixed = parseCsv(
      "date,region,revenue\n" +
        ",North,100\n" +
        ",North,200\n" +
        "2026-01-05,South,300\n" +
        "2026-02-03,South,500\n",
    );
    expect(
      answerQuestion("revenue change by month where region is North", mixed),
    ).toBe(
      "I could not compute the change in total revenue by month — " +
        "none of the 2 matching rows has a usable date.",
    );
  });
});

describe("composeAnswer missing values", () => {
  it("counts one column's missing rows with a percentage", () => {
    expect(answerQuestion("how many rows are missing units", SALES)).toBe(
      "1 of 6 rows is missing units (16.67%).",
    );
  });

  it("says so when a column has no missing rows", () => {
    expect(answerQuestion("how many rows are missing revenue", SALES)).toBe(
      "No rows are missing revenue (0 of 6 rows).",
    );
  });

  it("reports every column, worst first", () => {
    expect(answerQuestion("which columns have missing values", SALES)).toBe(
      "Missing values (6 rows):\n" +
        "- units: 1 of 6 rows missing (16.67%)\n" +
        "- date: 0 of 6 rows missing (0%)\n" +
        "- product: 0 of 6 rows missing (0%)\n" +
        "- region: 0 of 6 rows missing (0%)\n" +
        "- revenue: 0 of 6 rows missing (0%)",
    );
  });

  it("says so plainly when a sheet has no missing values at all", () => {
    const clean = parseCsv("a,b\n1,x\n2,y\n");
    expect(answerQuestion("which columns have missing values", clean)).toBe(
      "No missing values — every column has a value in all 2 rows.",
    );
  });

  it("lists the rows missing a column as a table", () => {
    expect(answerQuestion("show rows missing units", SALES)).toBe(
      "1 row missing units:\n" +
        "| date | region | product | units | revenue |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| 2026-01-10 | North | Widget A |  | 0 |",
    );
  });

  it("says so when no rows are missing the listed column", () => {
    expect(answerQuestion("show rows missing revenue", SALES)).toBe(
      "No rows are missing revenue.",
    );
  });

  it("counts over the filtered rows only", () => {
    expect(answerQuestion("how many rows are missing units in North", SALES)).toBe(
      "1 of 3 rows is missing units (33.33%).",
    );
  });
});

// Same scores fixture as the engine tests: the Tukey fence for
// score is [2.75, 20.75] and only Tim's 1000 is an outlier.
const SCORES = parseCsv(
  "student,subject,score,hours\n" +
    "Ada,Math,12,5\n" +
    "Grace,Math,8,7\n" +
    "Alan,Science,15,6\n" +
    "Katherine,Science,11,8\n" +
    "Edsger,Math,9,4\n" +
    "Linus,Science,13,9\n" +
    "Margaret,Math,10,6\n" +
    "Tim,Science,1000,7\n",
);

describe("composeAnswer outliers", () => {
  it("counts one column's outliers with a percentage and the fence", () => {
    expect(answerQuestion("how many outliers in score", SCORES)).toBe(
      "1 of 8 rows is an outlier in score (12.5%) outside [2.75, 20.75] (seen 1,000).",
    );
  });

  it("says so with the fence when a column has no outliers", () => {
    expect(answerQuestion("how many outliers in revenue", SALES)).toBe(
      "No outliers in revenue — every value is inside [-47.62, 412.58].",
    );
  });

  it("reports every numeric column, worst first", () => {
    expect(answerQuestion("which columns have outliers", SCORES)).toBe(
      "Outliers (8 rows):\n" +
        "- score: 1 outlier outside [2.75, 20.75] (seen 1,000)\n" +
        "- hours: 0 outliers (inside [2.5, 10.5])",
    );
  });

  it("says so plainly when a sheet has no outliers at all", () => {
    expect(answerQuestion("which columns have outliers", SALES)).toBe(
      "No outliers — every numeric value in the 6 rows is inside its fence.",
    );
  });

  it("lists the outlier rows as a table", () => {
    expect(answerQuestion("show outliers in score", SCORES)).toBe(
      "1 row that is an outlier in score:\n" +
        "| student | subject | score | hours |\n" +
        "| --- | --- | --- | --- |\n" +
        "| Tim | Science | 1,000 | 7 |",
    );
  });

  it("says so when no row is an outlier in the listed column", () => {
    expect(answerQuestion("show outliers in revenue", SALES)).toBe(
      "No rows are outliers in revenue.",
    );
  });

  it("says so when there are too few values for a fence", () => {
    const sheet = parseCsv("x,y\n1,10\n2,20\n3,1000\n");
    expect(answerQuestion("how many outliers in y", sheet)).toBe(
      "Too few values to judge outliers in y — only 3 of 3 rows have a value (at least 4 needed).",
    );
  });

  it("counts over the filtered rows only — the fence moves with the filter", () => {
    expect(answerQuestion("how many outliers in score in Math", SCORES)).toBe(
      "No outliers in score — every value is inside [4.75, 14.75].",
    );
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

describe("composeAnswer duplicates", () => {
  it("counts one column's duplicates with a percentage and the repeated values", () => {
    expect(answerQuestion("how many duplicate products", DUPS)).toBe(
      "4 of 7 rows are duplicates in product (57.14%) — 2 values appear more than once.",
    );
  });

  it("uses the singular form for one duplicate", () => {
    const sheet = parseCsv("x\nA\nB\nA\n");
    expect(answerQuestion("how many duplicates in x", sheet)).toBe(
      "1 of 3 rows is a duplicate in x (33.33%) — 1 value appears more than once.",
    );
  });

  it("says so when a column has no duplicates, naming the blank rows", () => {
    expect(answerQuestion("how many duplicate units", SALES)).toBe(
      "No duplicates in units — every value appears once (5 of 6 had a value).",
    );
  });

  it("says so when a column has no usable value at all", () => {
    const sheet = parseCsv("x,y\n,1\n,2\n");
    expect(answerQuestion("how many duplicates in x", sheet)).toBe(
      "I could not check duplicates in x — none of the 2 matching rows has a value.",
    );
  });

  it("reports the exact duplicate rows and every column, worst first", () => {
    expect(answerQuestion("how many duplicate rows", DUPS)).toBe(
      "3 of 7 rows are exact duplicates of an earlier row.\n" +
        "Duplicates by column:\n" +
        "- product: 4 duplicate rows (2 values appear more than once)\n" +
        "- region: 3 duplicate rows (2 values appear more than once)\n" +
        "- units: 3 duplicate rows (2 values appear more than once)",
    );
  });

  it("says so plainly when a sheet has no duplicates at all", () => {
    const sheet = parseCsv("x,y\n1,a\n2,b\n3,c\n");
    expect(answerQuestion("how many duplicate rows", sheet)).toBe(
      "No duplicates — every row is unique and every value appears once in each column.",
    );
  });

  it("names the clean columns when only some columns repeat", () => {
    expect(answerQuestion("how many duplicate rows", SALES)).toBe(
      "No exact duplicate rows.\n" +
        "Duplicates by column:\n" +
        "- product: 3 duplicate rows (2 values appear more than once)\n" +
        "- region: 2 duplicate rows (1 value appears more than once)\n" +
        "- date: 0 duplicates\n" +
        "- revenue: 0 duplicates\n" +
        "- units: 0 duplicates",
    );
  });

  it("lists the exact duplicate rows as a table", () => {
    expect(answerQuestion("show duplicate rows", DUPS)).toBe(
      "3 rows that are exact duplicates of an earlier row:\n" +
        "| region | product | units |\n" +
        "| --- | --- | --- |\n" +
        "| North | Widget A | 12 |\n" +
        "| South | Widget B | 8 |\n" +
        "| North | Widget A | 12 |",
    );
  });

  it("lists the rows that are duplicates in one column", () => {
    expect(answerQuestion("show duplicates in product", DUPS)).toBe(
      "4 rows that are duplicates in product:\n" +
        "| region | product | units |\n" +
        "| --- | --- | --- |\n" +
        "| North | Widget A | 12 |\n" +
        "| South | Widget B | 8 |\n" +
        "| North | Widget A | 12 |\n" +
        "| West | Widget B | 3 |",
    );
  });

  it("says so when no row is a duplicate in the listed column", () => {
    expect(answerQuestion("show duplicates in units", SALES)).toBe(
      "No rows are duplicates in units.",
    );
  });

  it("says so when no row is an exact duplicate", () => {
    expect(answerQuestion("show duplicate rows", SALES)).toBe(
      "No rows are exact duplicates of an earlier row.",
    );
  });
});
