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
      groupBy: "region",
      column: "revenue",
      op: "sum",
      groups: [
        { key: "East", value: 400, count: 1 },
        { key: "North", value: 389.97, count: 3 },
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
