import { describe, expect, it } from "vitest";
import {
  EVAL_GATE,
  GOLD_SET,
  formatReport,
  isAbstention,
  loadSheet,
  runEval,
  scoreCase,
  type EvalCase,
} from "../src/eval.js";

describe("scoreCase", () => {
  const answerCase: EvalCase = {
    sheet: "sales",
    question: "total revenue",
    expect: ["439.92"],
    note: "240 + 199.92",
  };

  it("passes when every expected substring is present", () => {
    const r = scoreCase(answerCase, "Total revenue is 439.92 (across 2 rows).");
    expect(r.passed).toBe(true);
    expect(r.detail).toBe("");
  });

  it("fails naming the missing substrings", () => {
    const r = scoreCase(answerCase, "Total revenue is 100 (across 2 rows).");
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/missing: 439.92/);
  });

  it("fails an answerable question that abstained", () => {
    const r = scoreCase(answerCase, "I can't answer that from this data: no column named in the question.");
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/got an abstention/);
  });

  it("scores abstention cases on the abstention itself", () => {
    const abstain: EvalCase = {
      sheet: "sales",
      question: "total profit",
      expect: "abstain",
      note: "no profit column",
    };
    expect(scoreCase(abstain, "I can't answer that from this data: no column named in the question.").passed).toBe(true);
    expect(scoreCase(abstain, "Total profit is 100.").passed).toBe(false);
  });
});

describe("isAbstention", () => {
  it("recognises the composer's abstention wording", () => {
    expect(isAbstention("I can't answer that from this data: no column named.")).toBe(true);
    expect(isAbstention("Total revenue is 439.92 (across 2 rows).")).toBe(false);
  });
});

describe("runEval", () => {
  it("loads all bundled sheets and scores the gold set", () => {
    expect(loadSheet("sales").headers).toEqual(["date", "region", "product", "units", "revenue"]);
    expect(loadSheet("employees").rows).toHaveLength(5);
    expect(loadSheet("monthly").rows).toHaveLength(12);
    expect(loadSheet("scores").rows).toHaveLength(8);
    expect(loadSheet("duplicates").rows).toHaveLength(7);
    const report = runEval();
    expect(report.cases).toHaveLength(GOLD_SET.length);
    expect(report.answerable).toBe(GOLD_SET.filter((c) => c.expect !== "abstain").length);
    expect(report.abstentionCases).toBe(GOLD_SET.filter((c) => c.expect === "abstain").length);
    expect(report.answerRate).toBe(1);
  });

  it("reports 100% on the gold set — every case is a regression guard", () => {
    const report = runEval();
    const failures = report.cases.filter((c) => !c.passed);
    expect(failures).toEqual([]);
    expect(report.overallAccuracy).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("fails a report whose accuracy drops below the gate", () => {
    // A gold set with one unanswerable-by-design question still passes
    // the 0.8 gate; two out of two failing must not.
    const bad: EvalCase[] = [
      { sheet: "sales", question: "total revenue", expect: ["not-a-number"], note: "wrong on purpose" },
      { sheet: "sales", question: "total profit", expect: ["1"], note: "wrong on purpose" },
    ];
    const report = runEval(bad);
    expect(report.overallAccuracy).toBe(0);
    expect(report.passed).toBe(false);
    expect(EVAL_GATE).toBe(0.8);
  });

  it("formats a readable per-case report", () => {
    const report = runEval([GOLD_SET[0]]);
    const text = formatReport(report);
    expect(text).toMatch(/PASS \[sales\] total revenue/);
    expect(text).toMatch(/Overall accuracy:\s+100\.0%/);
    expect(text).toMatch(/EVAL PASSED/);
  });

  it("scores a single-case subset against the bundled sheet", () => {
    const report = runEval([GOLD_SET[0]]);
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0].passed).toBe(true);
    expect(report.cases[0].answer).toMatch(/1,789\.6/);
  });
});
