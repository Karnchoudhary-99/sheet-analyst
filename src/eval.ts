/**
 * Eval harness: a gold question set over the bundled sample sheets,
 * scored against the answers the engine actually produces.
 *
 * The point is regression protection, not a leaderboard: if a parser
 * or engine change breaks a question that used to work, the eval
 * fails loudly instead of shipping a silent wrong answer. Expected
 * values are hand-computed from the sample CSVs (see the notes on
 * each case), never derived from the code under test — otherwise the
 * eval would just agree with itself.
 *
 * Metrics, all on the gold set:
 * - answer accuracy: correct answers / answerable questions
 * - abstention accuracy: correct abstentions / unanswerable questions
 * - overall accuracy: all correct / all questions
 * - answer rate: answerable questions that got an answer at all
 *
 * `npm run eval` prints a per-case table and exits non-zero when
 * overall accuracy drops below {@link EVAL_GATE} (0.8), so CI gates
 * on it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestion } from "./answer.js";
import { parseCsv } from "./csv.js";

export type SheetName = "sales" | "employees" | "monthly";

/**
 * One gold case. `expect` is either the substrings a correct answer
 * must contain, or `"abstain"` when the honest answer is to refuse.
 */
export interface EvalCase {
  sheet: SheetName;
  question: string;
  expect: string[] | "abstain";
  /** How the expected value was worked out, for the next reader. */
  note: string;
}

export const EVAL_GATE = 0.8;

/**
 * Gold set over examples/sales.csv (8 rows),
 * examples/employees.csv (5 rows) and examples/monthly-sales.csv
 * (12 rows, Jan–Mar 2026). Expected figures hand-computed:
 *
 * sales — revenue total 1,789.60; units total 72 over 7 valued rows
 * (one blank) so average units is 10.29; revenue by region:
 * South 649.77, East 624.91, North 389.97, West 124.95; top product
 * by revenue is Widget A at 640.
 *
 * employees — salaries 95,000 / 98,000 / 88,000 / 91,000 plus one NA,
 * so average and median are both 93,000; total salary by department:
 * Engineering 193,000, Data 179,000; highest salary is Grace Hopper
 * at 98,000; 3 of the 5 employees are in Engineering.
 *
 * monthly — revenue by month: Jan 664.91 (4 rows), Feb 914.81
 * (4 rows), Mar 834.81 (4 rows), total 2,414.53; average revenue by
 * month: Jan 166.23, Feb 228.70, Mar 208.70; top month is Feb 914.81.
 *
 * correlation — sales units vs revenue: r = 0.90 (strong positive,
 * 7 paired rows — the blank-units row drops out); employees id vs
 * salary: r = −0.65 (moderate negative, 4 paired rows — the NA
 * salary row drops out). Correlation with a text column abstains.
 *
 * comparison — monthly revenue Jan 664.91 → Feb 914.81 is +249.90
 * (+37.58%); Feb 914.81 → Mar 834.81 is −80.00 (−8.74%); employees
 * average salary 2023 (Grace, 98,000) → 2024 (Ada 95,000 and
 * Katherine 91,000, average 93,000) is −5,000 (−5.10%). A
 * comparison naming one period, or the same period twice, abstains.
 *
 * share — sales revenue by region: North 389.97 / 1,789.60 = 21.79%,
 * South 649.77 / 1,789.60 = 36.31%; North is 3 of 8 rows (37.5%);
 * employees salary: Engineering 193,000 / 372,000 = 51.88%. A share
 * with no group, of an average, or of a missing column abstains.
 *
 * distinct values — sales regions: North 3, East 2, South 2, West 1
 * (most frequent first, alphabetical tie-break); sales products in
 * North: Widget A 2, "Widget, Deluxe" 1; employees departments:
 * Engineering 3, Data 2. A distinct question naming no column abstains.
 *
 * multi-column group-by — sales revenue by region and product:
 * South · Widget C 449.85, East · Widget A 400, North · Widget A
 * 240 (2 rows), East · Widget B 224.91, South · Widget B 199.92,
 * North · "Widget, Deluxe" 149.97, West · Widget B 124.95;
 * employees by department and remote: Engineering · true 2, then
 * Data · false, Data · true and Engineering · false at 1 each
 * (alphabetical tie-break); monthly revenue by region and product:
 * South · Widget A 420 (120 + 300, 2 rows), East · Widget C
 * 314.93, North · Widget B 299.88. A time bucket plus a second
 * group column, or a group word that is not a column, abstains.
 */
export const GOLD_SET: EvalCase[] = [
  {
    sheet: "sales",
    question: "total revenue",
    expect: ["1,789.6"],
    note: "240 + 199.92 + 149.97 + 400 + 124.95 + 0 + 449.85 + 224.91 = 1,789.60",
  },
  {
    sheet: "sales",
    question: "average units",
    expect: ["10.29"],
    note: "72 units over 7 valued rows (one blank) = 10.2857…, formatted to 2dp",
  },
  {
    sheet: "sales",
    question: "how many rows",
    expect: ["8 matching rows"],
    note: "sales.csv has 8 data rows",
  },
  {
    sheet: "sales",
    question: "total revenue by region",
    expect: ["South: 649.77", "North: 389.97"],
    note: "South 199.92 + 449.85 = 649.77; North 240 + 149.97 + 0 = 389.97",
  },
  {
    sheet: "sales",
    question: "top 3 products by revenue",
    expect: ["Top 3 of 4 groups", "Widget A: 640"],
    note: "Widget A 240 + 400 + 0 = 640; Widget B 549.78; Widget C 449.85",
  },
  {
    sheet: "sales",
    question: "highest revenue",
    expect: ["Widget C", "449.85"],
    note: "largest single revenue row is Widget C, South, 449.85",
  },
  {
    sheet: "sales",
    question: "total revenue where region is North",
    expect: ["389.97"],
    note: "240 + 149.97 + 0 = 389.97 over the 3 North rows",
  },
  {
    sheet: "sales",
    question: "show rows where region is North",
    expect: ["3 matching rows", "Widget A"],
    note: "3 North rows, all Widget A except the Deluxe row",
  },
  {
    sheet: "sales",
    question: "what is the weather",
    expect: "abstain",
    note: "no aggregate, no column, no filter — nothing to answer from",
  },
  {
    sheet: "sales",
    question: "total profit",
    expect: "abstain",
    note: "no 'profit' column exists — guessing would answer a different question",
  },
  {
    sheet: "employees",
    question: "average salary",
    expect: ["93,000"],
    note: "(95,000 + 98,000 + 88,000 + 91,000) / 4 = 93,000; the NA row is skipped",
  },
  {
    sheet: "employees",
    question: "median salary",
    expect: ["93,000"],
    note: "sorted 88,000 / 91,000 / 95,000 / 98,000 — middle pair averages to 93,000",
  },
  {
    sheet: "employees",
    question: "how many employees",
    expect: ["5 matching rows"],
    note: "employees.csv has 5 data rows",
  },
  {
    sheet: "employees",
    question: "total salary by department",
    expect: ["Engineering: 193,000", "Data: 179,000"],
    note: "Engineering 95,000 + 98,000 = 193,000 (NA skipped); Data 88,000 + 91,000",
  },
  {
    sheet: "employees",
    question: "highest salary",
    expect: ["Grace Hopper", "98,000"],
    note: "largest salary row is Grace Hopper, Engineering, 98,000",
  },
  {
    sheet: "employees",
    question: "average salary where department is Data",
    expect: ["89,500"],
    note: "(88,000 + 91,000) / 2 = 89,500",
  },
  {
    sheet: "employees",
    question: "how many employees in Engineering",
    expect: ["3 matching rows"],
    note: "'in Engineering' resolves to the department value; 3 of 5 rows match",
  },
  {
    sheet: "employees",
    question: "how many employees by department",
    expect: ["Engineering: 3", "Data: 2"],
    note: "group count: Engineering 3, Data 2",
  },
  {
    sheet: "employees",
    question: "total age",
    expect: "abstain",
    note: "no 'age' column exists",
  },
  {
    sheet: "monthly",
    question: "total revenue by month",
    expect: ["Jan 2026: 664.91", "Feb 2026: 914.81", "Mar 2026: 834.81"],
    note: "Jan 200 + 124.95 + 160 + 179.96 = 664.91; Feb 299.88 + 120 + 314.93 + 180 = 914.81; Mar 134.97 + 300 + 249.90 + 149.94 = 834.81",
  },
  {
    sheet: "monthly",
    question: "average revenue by month",
    expect: ["Jan 2026: 166.23", "Feb 2026: 228.7", "Mar 2026: 208.7"],
    note: "Jan 664.91/4 = 166.2275; Feb 914.81/4 = 228.7025; Mar 834.81/4 = 208.7025",
  },
  {
    sheet: "monthly",
    question: "how many rows by month",
    expect: ["Jan 2026: 4", "Feb 2026: 4", "Mar 2026: 4"],
    note: "4 rows in each of Jan, Feb and Mar 2026",
  },
  {
    sheet: "monthly",
    question: "top 2 months by revenue",
    expect: ["Top 2 of 3 months", "Feb 2026: 914.81", "Mar 2026: 834.81"],
    note: "Feb 914.81 is the top month, Mar 834.81 second; Jan 664.91 is cut",
  },
  {
    sheet: "monthly",
    question: "total revenue by decade",
    expect: "abstain",
    note: "decade is not a supported period — must not silently answer the plain total",
  },
  {
    sheet: "sales",
    question: "correlation between revenue and units",
    expect: ["0.90", "strong positive", "7 paired rows"],
    note: "7 paired rows (blank-units row drops out); Pearson r = 0.9015, hand-computed from the 7 (units, revenue) pairs",
  },
  {
    sheet: "employees",
    question: "correlation between id and salary",
    expect: ["-0.65", "moderate negative", "4 paired rows"],
    note: "4 paired rows (NA salary row drops out); Pearson r = -0.6459, hand-computed from (1, 95000), (2, 98000), (3, 88000), (4, 91000)",
  },
  {
    sheet: "sales",
    question: "correlation between revenue and region",
    expect: "abstain",
    note: "region is text — correlation needs two numeric columns",
  },
  {
    sheet: "monthly",
    question: "compare revenue Jan 2026 vs Feb 2026",
    expect: ["grew from 664.91", "914.81", "+249.9", "+37.58%"],
    note: "Jan 664.91 → Feb 914.81: +249.90, 249.90/664.91 = 37.58%",
  },
  {
    sheet: "monthly",
    question: "revenue change from February to March",
    expect: ["fell from 914.81", "834.81", "-80", "-8.74%"],
    note: "Feb 914.81 → Mar 834.81: −80.00, 80/914.81 = 8.74%",
  },
  {
    sheet: "employees",
    question: "compare average salary 2023 vs 2024",
    expect: ["fell from 98,000", "93,000", "-5,000", "-5.1%"],
    note: "2023 is Grace alone, 98,000; 2024 averages Ada 95,000 and Katherine 91,000 = 93,000: −5,000, 5000/98000 = 5.10%",
  },
  {
    sheet: "monthly",
    question: "compare average revenue Jan 2026 vs Feb 2026",
    expect: ["166.23", "228.7", "+62.4", "+37.58%"],
    note: "Jan avg 664.91/4 = 166.23, Feb avg 914.81/4 = 228.70: delta 62.475, which prints as 62.47 (the double is just under .475) — the substring only pins the magnitude; same +37.58% ratio as the totals",
  },
  {
    sheet: "monthly",
    question: "compare revenue Jan 2026",
    expect: "abstain",
    note: "one period named — a comparison needs two",
  },
  {
    sheet: "monthly",
    question: "compare revenue Jan 2026 vs Jan 2026",
    expect: "abstain",
    note: "both periods are the same month",
  },
  {
    sheet: "sales",
    question: "what share of revenue is North",
    expect: ["21.79%", "389.97", "1,789.6"],
    note: "North 240 + 149.97 + 0 = 389.97; total 1,789.60; 389.97/1789.60 = 21.79%",
  },
  {
    sheet: "sales",
    question: "what percentage of rows are in North",
    expect: ["3 of 8 rows", "37.5%"],
    note: "3 of the 8 sales rows are North: 3/8 = 37.5%",
  },
  {
    sheet: "employees",
    question: "what share of salary is Engineering",
    expect: ["51.88%", "193,000", "372,000"],
    note: "Engineering 95,000 + 98,000 = 193,000 (NA skipped); total 372,000; 193000/372000 = 51.88%",
  },
  {
    sheet: "sales",
    question: "what share of revenue is South",
    expect: ["36.31%", "649.77"],
    note: "South 199.92 + 449.85 = 649.77; 649.77/1789.60 = 36.31%",
  },
  {
    sheet: "sales",
    question: "what share of revenue",
    expect: "abstain",
    note: "no group named — a share needs a subset to compare against the whole",
  },
  {
    sheet: "sales",
    question: "what share of average revenue is North",
    expect: "abstain",
    note: "a share compares totals, not averages",
  },
  {
    sheet: "sales",
    question: "what share of profit is North",
    expect: "abstain",
    note: "no 'profit' column exists",
  },
  {
    sheet: "sales",
    question: "list unique regions",
    expect: ["North: 3", "East: 2", "South: 2", "West: 1"],
    note: "North 3 rows, East and South 2 each (alphabetical tie-break), West 1",
  },
  {
    sheet: "sales",
    question: "list unique products in North",
    expect: ["Widget A: 2", "Widget, Deluxe: 1"],
    note: "North rows are Widget A twice and 'Widget, Deluxe' once (Widget C is South)",
  },
  {
    sheet: "employees",
    question: "what are the distinct departments",
    expect: ["Engineering: 3", "Data: 2"],
    note: "3 of the 5 employees are in Engineering, 2 in Data",
  },
  {
    sheet: "sales",
    question: "list unique profit",
    expect: "abstain",
    note: "no 'profit' column exists",
  },
  {
    sheet: "sales",
    question: "total revenue by region and product",
    expect: ["South · Widget C: 449.85", "North · Widget A: 240"],
    note: "South · Widget C 449.85 is the largest pair; North · Widget A is 240 + 0 = 240 over 2 rows",
  },
  {
    sheet: "employees",
    question: "how many employees by department and remote",
    expect: ["Engineering · true: 2", "Data · false: 1"],
    note: "Engineering · true is Ada + Grace (2); the three 1-count pairs sort alphabetically by composite key",
  },
  {
    sheet: "monthly",
    question: "total revenue by region and product",
    expect: ["South · Widget A: 420", "East · Widget C: 314.93"],
    note: "South · Widget A is 120 + 300 = 420 over 2 rows; East · Widget C is a single 314.93 row",
  },
  {
    sheet: "sales",
    question: "total revenue by region and product by month",
    expect: "abstain",
    note: "a time bucket plus a second group column is two dimensions at once",
  },
  {
    sheet: "sales",
    question: "total revenue by month and region",
    expect: "abstain",
    note: "same two-dimensions problem, written the other way round — must not silently answer the monthly grouping",
  },
  {
    sheet: "sales",
    question: "total revenue by region and profit",
    expect: "abstain",
    note: "'profit' is not a column — must not silently answer as 'by region'",
  },
];

export interface CaseResult {
  case: EvalCase;
  answer: string;
  passed: boolean;
  /** What was missing (expected substrings not found, or an answer where an abstention was expected). */
  detail: string;
}

export interface EvalReport {
  cases: CaseResult[];
  answerable: number;
  answerCorrect: number;
  abstentionCases: number;
  abstentionCorrect: number;
  /** Fraction of answerable questions that produced an answer at all. */
  answerRate: number;
  answerAccuracy: number;
  abstentionAccuracy: number;
  overallAccuracy: number;
  passed: boolean;
}

export function isAbstention(answer: string): boolean {
  return answer.startsWith("I can't answer that");
}

/** Score one case against the answer the engine produced. */
export function scoreCase(c: EvalCase, answer: string): CaseResult {
  if (c.expect === "abstain") {
    const passed = isAbstention(answer);
    return {
      case: c,
      answer,
      passed,
      detail: passed ? "" : "expected an abstention, got an answer",
    };
  }
  if (isAbstention(answer)) {
    return {
      case: c,
      answer,
      passed: false,
      detail: "expected an answer, got an abstention",
    };
  }
  const missing = c.expect.filter((s) => !answer.includes(s));
  return {
    case: c,
    answer,
    passed: missing.length === 0,
    detail: missing.length > 0 ? `missing: ${missing.join("; ")}` : "",
  };
}

const SHEET_FILES: Record<SheetName, string> = {
  sales: "sales.csv",
  employees: "employees.csv",
  monthly: "monthly-sales.csv",
};

export function loadSheet(name: SheetName): ReturnType<typeof parseCsv> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
  return parseCsv(readFileSync(join(dir, SHEET_FILES[name]), "utf8"));
}

/** Run the whole gold set and score it. Pure apart from reading the sample CSVs. */
export function runEval(cases: EvalCase[] = GOLD_SET): EvalReport {
  const sheets = new Map<SheetName, ReturnType<typeof parseCsv>>();
  const sheet = (name: SheetName) => {
    const loaded = sheets.get(name) ?? loadSheet(name);
    sheets.set(name, loaded);
    return loaded;
  };
  const results = cases.map((c) =>
    scoreCase(c, answerQuestion(c.question, sheet(c.sheet))),
  );
  const answerable = results.filter((r) => r.case.expect !== "abstain");
  const abstentions = results.filter((r) => r.case.expect === "abstain");
  const answerCorrect = answerable.filter((r) => r.passed).length;
  const abstentionCorrect = abstentions.filter((r) => r.passed).length;
  const answered = answerable.filter((r) => !isAbstention(r.answer)).length;
  const overallAccuracy =
    results.length === 0
      ? 1
      : (answerCorrect + abstentionCorrect) / results.length;
  return {
    cases: results,
    answerable: answerable.length,
    answerCorrect,
    abstentionCases: abstentions.length,
    abstentionCorrect,
    answerRate: answerable.length === 0 ? 1 : answered / answerable.length,
    answerAccuracy: answerable.length === 0 ? 1 : answerCorrect / answerable.length,
    abstentionAccuracy:
      abstentions.length === 0 ? 1 : abstentionCorrect / abstentions.length,
    overallAccuracy,
    passed: overallAccuracy >= EVAL_GATE,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatReport(report: EvalReport): string {
  const lines = report.cases.map((r) => {
    const mark = r.passed ? "PASS" : "FAIL";
    const detail = r.detail ? ` — ${r.detail}` : "";
    return `${mark} [${r.case.sheet}] ${r.case.question}${detail}`;
  });
  lines.push("");
  lines.push(`Answer accuracy:     ${report.answerCorrect}/${report.answerable} (${pct(report.answerAccuracy)})`);
  lines.push(`Abstention accuracy: ${report.abstentionCorrect}/${report.abstentionCases} (${pct(report.abstentionAccuracy)})`);
  lines.push(`Answer rate:         ${pct(report.answerRate)}`);
  lines.push(`Overall accuracy:    ${pct(report.overallAccuracy)} (gate: ${pct(EVAL_GATE)})`);
  lines.push(report.passed ? "EVAL PASSED" : "EVAL FAILED");
  return lines.join("\n");
}

export function main(): number {
  const report = runEval();
  console.log(formatReport(report));
  return report.passed ? 0 : 1;
}

// `npm run eval` (tsx) and the built `node dist/eval.js` both land here.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  process.exitCode = main();
}
