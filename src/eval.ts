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

export type SheetName = "sales" | "employees" | "monthly" | "scores" | "duplicates";

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
 * examples/employees.csv (5 rows), examples/monthly-sales.csv
 * (12 rows, Jan–Mar 2026), examples/scores.csv (8 rows, one
 * planted outlier — Tim's score of 1000 among scores of 8–15) and
 * examples/duplicates.csv (7 rows, three planted repeat rows —
 * North/Widget A/12 three times, South/Widget B/8 twice).
 * Expected figures hand-computed:
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
 *
 * top-N over multi-column groups — sales top 3 region and product
 * by revenue: South · Widget C 449.85, East · Widget A 400,
 * North · Widget A 240 (7 pairs in all); monthly top 2: South ·
 * Widget A 420, East · Widget C 314.93 (11 pairs in all). A top-N
 * over two groups plus a time bucket abstains.
 *
 * bottom-N — the low end of the same ranking ("bottom 3 products
 * by revenue", "bottom 2 months by revenue", "bottom revenue"):
 * sales products ascending are Widget, Deluxe 149.97, Widget C
 * 449.85, Widget B 549.78, Widget A 640; regions ascending are
 * West 124.95, North 389.97, East 624.91, South 649.77; months
 * ascending are Jan 664.91, Mar 834.81, Feb 914.81; monthly
 * region × product pairs ascending start South · Widget B 124.95,
 * North · Widget C 134.97, West · Widget B 149.94. Answers are
 * headed "Bottom N of M", never "Top N". A bottom-N over a group
 * plus a time bucket abstains, same as top-N.
 *
 * sorted rows — "show rows sorted by revenue descending" lists the
 * 8 sales rows highest first (449.85, 400, 240, 224.91, 199.92,
 * 149.97, 124.95, 0); ascending puts the zero-revenue row first and
 * the blank-units row sorts last in both directions (it has no
 * units value at all). "show rows sorted by region" orders East,
 * East, North, North, North, South, South, West. The gold cases assert order by
 * expecting a substring that spans two adjacent table rows, so a
 * wrong order fails even though every row is present. Sorting an
 * unknown column, or putting a sort phrase on an aggregate,
 * abstains.
 *
 * above/below average — sales revenue averages 223.7 over 8 rows,
 * so 4 rows sit above it (224.91, 240, 400, 449.85) and 4 below
 * (0, 124.95, 149.97, 199.92); employees salaries average and
 * median 93,000 (the NA row skipped), so 2 sit above it (95,000,
 * 98,000) and 2 below (88,000, 91,000). The comparison is strict —
 * a row exactly at the baseline is neither above nor below it.
 * An unknown column, a non-numeric column, or a grouped comparison
 * abstains.
 *
 * mode and distinct count — sales regions: North 3, South 2, East 2,
 * West 1, so the mode is North (3 of 8 rows, 4 distinct values);
 * sales products tie at 3 each (Widget A, Widget B) so the
 * alphabetical tie-break picks Widget A; products in North are
 * Widget A 2, "Widget, Deluxe" 1 (2 distinct values); employees
 * departments are Engineering 3, Data 2, so the mode is Engineering
 * (3 of 5 rows, 2 distinct values). A mode or distinct count naming
 * no column abstains.
 *
 * percentile and between — employees salaries sorted 88,000 /
 * 91,000 / 95,000 / 98,000 (NA skipped): p90 is 97,100, p50 is
 * 93,000, p25 is 90,250; sales revenue p75 is 280 and p90 is
 * 414.96; the North-filtered p90 is 221.99. Revenue between 100
 * and 200 totals 474.84 over 3 rows; average salary between 90,000
 * and 96,000 is 93,000. A percentile outside 1–99, over a text
 * column, grouped by another column, or a reversed between-range
 * abstains.
 *
 * trend — monthly revenue 664.91 / 914.81 / 834.81 fits a
 * least-squares slope of 84.95 per month; average revenue
 * 166.23 / 228.70 / 208.70 fits 21.24 per month; units 27 / 34 / 34
 * fit 3.5 per month; average salary by year falls 5,000 per year
 * (2023 98,000 → 2025 88,000, and 2022 has no usable value). A
 * trend with no period, over a text column, plus a second group
 * column, or by an unsupported period abstains.
 *
 * missing values — sales units is blank on the 2026-01-10 row
 * only (1 of 8, 12.5%); every other sales column is complete.
 * Employees salary is NA for Edsger Dijkstra only (1 of 5, 20%);
 * the 3 Engineering rows include his, so the Engineering-filtered
 * count is 1 of 3 (33.33%). A whole-sheet report lists every
 * column, worst first. "show rows missing salary" lists his row.
 * A missing question naming no column, or grouped by another
 * column, abstains.
 *
 * outliers — scores: 12, 8, 15, 11, 9, 13, 10, 1000, so Q1 = 9.5,
 * Q3 = 14 and the Tukey fence is [2.75, 20.75]; only Tim's 1000 is
 * outside it (1 of 8, 12.5%). Hours 5, 7, 6, 8, 4, 9, 6, 7 has no
 * outlier (fence [2.5, 10.5]). The Math-filtered fence is
 * [4.75, 14.75] with no outlier. Sales revenue (8 values) has
 * fence [-136.35, 593.81] and units (7 values) [-10, 30], both
 * clean; employees salaries (4 values) have fence
 * [79,000, 107,000], clean. An outlier question over a text
 * column, or grouped by another column, abstains.
 *
 * duplicates — duplicates.csv: 3 exact duplicate rows (rows 3 and
 * 6 repeat row 1, row 5 repeats row 2); per column, product has 4
 * duplicate rows (Widget A 3, Widget B 3 — 2 values repeat) and
 * region and units 3 each (North 3 / South 2, 12 three times /
 * 8 twice). Sales has no exact duplicate row, but product repeats
 * (Widget A 3, Widget B 3 — 4 duplicate rows) and region repeats
 * (North 3, South 2, East 2 — 4 duplicate rows); units are all
 * distinct (7 valued rows, one blank). A duplicate question over
 * an unknown column, or grouped by another column, abstains.
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
    question: "bottom 3 products by revenue",
    expect: ["Bottom 3 of 4 groups", "Widget, Deluxe: 149.97"],
    note: "ascending: Widget, Deluxe 149.97, Widget C 449.85, Widget B 549.78; Widget A 640 is cut",
  },
  {
    sheet: "sales",
    question: "bottom 2 regions by revenue",
    expect: ["Bottom 2 of 4 groups", "West: 124.95"],
    note: "ascending: West 124.95, North 389.97; East 624.91 and South 649.77 are cut",
  },
  {
    sheet: "sales",
    question: "lowest revenue",
    expect: ["Showing 1 of 8 matching rows", "2026-01-10", "Widget A"],
    note: "the lowest single revenue row is the zero-revenue Widget A row in North on 2026-01-10",
  },
  {
    sheet: "sales",
    question: "highest revenue",
    expect: ["Widget C", "449.85"],
    note: "largest single revenue row is Widget C, South, 449.85",
  },
  {
    sheet: "sales",
    question: "show rows sorted by revenue descending",
    expect: [
      "8 matching rows, sorted by revenue (descending)",
      "| 449.85 |\n| 2026-01-08 | East | Widget A | 20 | 400 |",
    ],
    note:
      "descending revenue is 449.85, 400, 240, 224.91, 199.92, 149.97, 124.95, 0 — the two-row span proves the 449.85 row comes first",
  },
  {
    sheet: "sales",
    question: "show rows sorted by revenue ascending",
    expect: [
      "8 matching rows, sorted by revenue (ascending)",
      "| 0 |\n| 2026-01-09 | West | Widget B | 5 | 124.95 |",
    ],
    note:
      "ascending revenue starts 0, 124.95 — the zero-revenue row (blank units) is first; the two-row span proves the order",
  },
  {
    sheet: "sales",
    question: "show rows sorted by region",
    expect: [
      "8 matching rows, sorted by region (ascending)",
      "| 2026-01-12 | East | Widget B | 9 | 224.91 |\n| 2026-01-05 | North | Widget A | 12 | 240 |",
    ],
    note: "regions sort East, East, North, North, North, South, South, West — the last East row precedes the first North row",
  },
  {
    sheet: "sales",
    question: "show rows sorted by profit descending",
    expect: "abstain",
    note: "no profit column — the parser refuses instead of listing unsorted rows",
  },
  {
    sheet: "sales",
    question: "total revenue sorted by region",
    expect: "abstain",
    note: "a sort phrase on an aggregate is refused instead of answering the plain total",
  },
  {
    sheet: "sales",
    question: "rows with revenue above average",
    expect: ["4 rows have revenue above the average of 223.7", "449.85"],
    note: "revenue averages 1,789.6 / 8 = 223.7; above it are 224.91, 240, 400, 449.85",
  },
  {
    sheet: "sales",
    question: "rows with revenue below average",
    expect: ["4 rows have revenue below the average of 223.7", "124.95"],
    note: "below 223.7 are 0, 124.95, 149.97, 199.92",
  },
  {
    sheet: "employees",
    question: "which employees have salary above the median",
    expect: ["2 rows have salary above the median of 93,000", "98,000"],
    note: "salaries sorted 88,000 / 91,000 / 95,000 / 98,000 (NA skipped) — median 93,000; above it are 95,000 and 98,000",
  },
  {
    sheet: "employees",
    question: "salary below average",
    expect: ["2 rows have salary below the average of 93,000", "88,000"],
    note: "average salary is also 93,000; below it are 88,000 and 91,000",
  },
  {
    sheet: "sales",
    question: "above average profit",
    expect: "abstain",
    note: "no profit column",
  },
  {
    sheet: "sales",
    question: "above average region",
    expect: "abstain",
    note: "region is text — comparing to its average makes no sense",
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
    question: "bottom 2 months by revenue",
    expect: ["Bottom 2 of 3 months", "Jan 2026: 664.91", "Mar 2026: 834.81"],
    note: "Jan 664.91 is the lowest month, Mar 834.81 second; Feb 914.81 is cut",
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
    question: "what share of revenues is North",
    expect: ["21.79%", "389.97", "1,789.6"],
    note: "same share as the singular phrasing — plural column names are tolerated",
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
  {
    sheet: "sales",
    question: "top 3 region and product by revenue",
    expect: ["Top 3 of 7 groups", "South · Widget C: 449.85", "North · Widget A: 240"],
    note: "7 region × product pairs; top 3 are South · Widget C 449.85, East · Widget A 400, North · Widget A 240",
  },
  {
    sheet: "monthly",
    question: "top 2 region and product by revenue",
    expect: ["Top 2 of 11 groups", "South · Widget A: 420"],
    note: "11 region × product pairs; top 2 are South · Widget A 420 (2 rows) and East · Widget C 314.93",
  },
  {
    sheet: "monthly",
    question: "bottom 3 region and product by revenue",
    expect: ["Bottom 3 of 11 groups", "South · Widget B: 124.95", "North · Widget C: 134.97"],
    note: "11 region × product pairs; bottom 3 are South · Widget B 124.95, North · Widget C 134.97, West · Widget B 149.94",
  },
  {
    sheet: "sales",
    question: "top 3 region and product by revenue by month",
    expect: "abstain",
    note: "a top-N over two groups plus a time bucket is two dimensions at once",
  },
  {
    sheet: "sales",
    question: "bottom 3 products by revenue by month",
    expect: "abstain",
    note: "a bottom-N over a group plus a time bucket is two dimensions at once, same as top-N",
  },
  {
    sheet: "sales",
    question: "most common region",
    expect: ["The most common region is North", "3 of 8 rows", "4 distinct values"],
    note: "North 3, South 2, East 2, West 1 — North is the mode",
  },
  {
    sheet: "sales",
    question: "most common product",
    expect: ["The most common product is Widget A", "3 of 8 rows"],
    note: "Widget A and Widget B tie at 3 rows each; the alphabetical tie-break picks Widget A",
  },
  {
    sheet: "sales",
    question: "most common product in North",
    expect: ["The most common product is Widget A", "2 of 3 rows", "2 distinct values"],
    note: "North rows are Widget A twice and 'Widget, Deluxe' once",
  },
  {
    sheet: "sales",
    question: "how many distinct regions",
    expect: ["Distinct region values is 4", "8 rows"],
    note: "North, South, East, West — 4 distinct regions over 8 rows",
  },
  {
    sheet: "sales",
    question: "how many distinct products",
    expect: ["Distinct product values is 4"],
    note: "Widget A, Widget B, Widget C and 'Widget, Deluxe'",
  },
  {
    sheet: "employees",
    question: "most common department",
    expect: ["The most common department is Engineering", "3 of 5 rows"],
    note: "Engineering 3, Data 2 — Engineering is the mode",
  },
  {
    sheet: "employees",
    question: "count distinct departments",
    expect: ["Distinct department values is 2"],
    note: "Engineering and Data — 2 distinct departments over 5 rows",
  },
  {
    sheet: "sales",
    question: "most common profit",
    expect: "abstain",
    note: "'profit' is not a column",
  },
  {
    sheet: "sales",
    question: "how many distinct profits",
    expect: "abstain",
    note: "'profit' is not a column",
  },
  {
    sheet: "employees",
    question: "90th percentile of salary",
    expect: ["97,100"],
    note: "salaries sorted 88,000 / 91,000 / 95,000 / 98,000 — rank 0.9 * 3 = 2.7: 95,000 + 0.7 * 3,000 = 97,100 (NA row skipped)",
  },
  {
    sheet: "employees",
    question: "50th percentile of salary",
    expect: ["93,000"],
    note: "rank 0.5 * 3 = 1.5: (91,000 + 95,000) / 2 = 93,000 — the median by another name",
  },
  {
    sheet: "employees",
    question: "25th percentile of salary",
    expect: ["90,250"],
    note: "rank 0.25 * 3 = 0.75: 88,000 + 0.75 * 3,000 = 90,250",
  },
  {
    sheet: "sales",
    question: "75th percentile of revenue",
    expect: ["280"],
    note: "revenue sorted 0 / 124.95 / 149.97 / 199.92 / 224.91 / 240 / 400 / 449.85 — rank 0.75 * 7 = 5.25: 240 + 0.25 * 160 = 280",
  },
  {
    sheet: "sales",
    question: "p90 revenue",
    expect: ["414.96"],
    note: "rank 0.9 * 7 = 6.3: 400 + 0.3 * 49.85 = 414.955, formatted to 2dp",
  },
  {
    sheet: "sales",
    question: "90th percentile of revenue in North",
    expect: ["221.99"],
    note: "North revenue sorted 0 / 149.97 / 240 — rank 0.9 * 2 = 1.8: 149.97 + 0.8 * 90.03 = 221.994, formatted to 2dp",
  },
  {
    sheet: "sales",
    question: "total revenue where revenue between 100 and 200",
    expect: ["474.84"],
    note: "199.92 + 149.97 + 124.95 = 474.84 over the 3 rows in [100, 200]; the 240 and 400 rows are outside",
  },
  {
    sheet: "sales",
    question: "how many rows where revenue between 100 and 200",
    expect: ["3 matching rows"],
    note: "3 of the 8 sales rows have revenue in [100, 200]",
  },
  {
    sheet: "employees",
    question: "average salary where salary between 90000 and 96000",
    expect: ["93,000"],
    note: "(91,000 + 95,000) / 2 = 93,000; the 88,000 and 98,000 rows are outside the range",
  },
  {
    sheet: "employees",
    question: "150th percentile of salary",
    expect: "abstain",
    note: "a percentile must be between 1 and 99",
  },
  {
    sheet: "sales",
    question: "90th percentile of region",
    expect: "abstain",
    note: "region is text — a percentile needs a numeric column",
  },
  {
    sheet: "employees",
    question: "90th percentile of salary by department",
    expect: "abstain",
    note: "a percentile is one column, ungrouped — must not answer the whole-sheet percentile",
  },
  {
    sheet: "sales",
    question: "total revenue where revenue between 200 and 100",
    expect: "abstain",
    note: "a reversed range matches nothing by construction — the smaller value must come first",
  },
  {
    sheet: "monthly",
    question: "revenue trend by month",
    expect: ["trended up", "84.95", "from 664.91 in Jan 2026", "to 834.81 in Mar 2026", "3 months"],
    note: "monthly totals 664.91 / 914.81 / 834.81: least-squares slope 169.9 / 2 = 84.95 per month",
  },
  {
    sheet: "monthly",
    question: "average revenue trend by month",
    expect: ["trended up", "21.24", "166.23", "208.7"],
    note: "monthly averages 166.2275 / 228.7025 / 208.7025: slope 42.475 / 2 = 21.2375 per month, formatted to 2dp",
  },
  {
    sheet: "monthly",
    question: "units trend by month",
    expect: ["trended up", "3.5 per month", "from 27 in Jan 2026", "to 34 in Mar 2026"],
    note: "monthly units 27 / 34 / 34: slope 7 / 2 = 3.5 per month",
  },
  {
    sheet: "employees",
    question: "average salary trend by year",
    expect: ["trended down", "5,000 per year", "from 98,000 in 2023", "to 88,000 in 2025", "2022 has no usable values"],
    note: "yearly averages 2022 NA (no usable value), 2023 98,000, 2024 93,000, 2025 88,000: slope over x = 1, 2, 3 is −5,000 per year",
  },
  {
    sheet: "monthly",
    question: "revenue trend",
    expect: "abstain",
    note: "no period named — a trend needs one, e.g. 'by month'",
  },
  {
    sheet: "monthly",
    question: "region trend by month",
    expect: "abstain",
    note: "region is text — a trend needs a numeric column",
  },
  {
    sheet: "monthly",
    question: "revenue trend by month and region",
    expect: "abstain",
    note: "a time bucket plus a second group column is two dimensions at once",
  },
  {
    sheet: "monthly",
    question: "revenue trend by decade",
    expect: "abstain",
    note: "decade is not a supported period — must not silently answer the plain total",
  },
  {
    sheet: "sales",
    question: "how many rows are missing units",
    expect: ["1 of 8 rows is missing units", "12.5%"],
    note: "units is blank on the 2026-01-10 row only",
  },
  {
    sheet: "sales",
    question: "how many rows are missing revenue",
    expect: ["No rows are missing revenue", "0 of 8"],
    note: "revenue is complete — a zero is a value, not a missing one",
  },
  {
    sheet: "sales",
    question: "which columns have missing values",
    expect: ["units: 1 of 8 rows missing (12.5%)", "revenue: 0 of 8 rows missing (0%)"],
    note: "only units has a blank; the report lists every column, worst first",
  },
  {
    sheet: "employees",
    question: "how many rows are missing salary",
    expect: ["1 of 5 rows is missing salary", "20%"],
    note: "Edsger Dijkstra's salary is NA",
  },
  {
    sheet: "employees",
    question: "how many rows are missing salaries",
    expect: ["1 of 5 rows is missing salary", "20%"],
    note: "same count as the singular phrasing — '-ies' plurals resolve to the column",
  },
  {
    sheet: "employees",
    question: "show rows missing salary",
    expect: ["1 row missing salary", "Edsger Dijkstra"],
    note: "his is the only row with an NA salary",
  },
  {
    sheet: "employees",
    question: "how many rows are missing salary in Engineering",
    expect: ["1 of 3 rows is missing salary", "33.33%"],
    note: "3 Engineering rows (Ada, Grace, Edsger); only Edsger's salary is NA",
  },
  {
    sheet: "sales",
    question: "how many rows are missing profit",
    expect: "abstain",
    note: "no profit column — the parser refuses instead of counting a column that does not exist",
  },
  {
    sheet: "sales",
    question: "how many rows are missing revenue by region",
    expect: "abstain",
    note: "a missing-values question is one column, ungrouped — must not answer the whole-sheet count",
  },
  {
    sheet: "sales",
    question: "show rows missing values",
    expect: "abstain",
    note: "listing missing rows needs one column named",
  },
  {
    sheet: "scores",
    question: "how many outliers in score",
    expect: ["1 of 8 rows is an outlier in score", "12.5%", "outside [2.75, 20.75]"],
    note: "scores 12, 8, 15, 11, 9, 13, 10, 1000: Q1 = 9.5, Q3 = 14, fence [2.75, 20.75]; only Tim's 1000 is outside it",
  },
  {
    sheet: "scores",
    question: "show outliers in score",
    expect: ["1 row that is an outlier in score", "Tim", "1,000"],
    note: "Tim is the only outlier row; the table formats his score with a thousands separator",
  },
  {
    sheet: "scores",
    question: "which columns have outliers",
    expect: ["score: 1 outlier outside [2.75, 20.75]", "hours: 0 outliers"],
    note: "score has the one outlier; hours (fence [2.5, 10.5]) has none; text columns never appear in the report",
  },
  {
    sheet: "scores",
    question: "how many outliers in score in Math",
    expect: ["No outliers in score", "[4.75, 14.75]"],
    note: "Math scores 12, 8, 9, 10: fence [4.75, 14.75] — the fence moves with the filter, and nothing is outside it",
  },
  {
    sheet: "scores",
    question: "how many outliers in hours",
    expect: ["No outliers in hours", "[2.5, 10.5]"],
    note: "hours 5, 7, 6, 8, 4, 9, 6, 7: Q1 = 5.5, Q3 = 7.5, fence [2.5, 10.5]",
  },
  {
    sheet: "sales",
    question: "how many outliers in revenue",
    expect: ["No outliers in revenue", "[-136.35, 593.81]"],
    note: "revenue 0, 124.95, 149.97, 199.92, 224.91, 240, 400, 449.85: Q1 = 137.46, Q3 = 320, fence [-136.35, 593.81]",
  },
  {
    sheet: "sales",
    question: "how many outliers in revenues",
    expect: ["No outliers in revenue", "[-136.35, 593.81]"],
    note: "same fence as the singular phrasing — plural column names are tolerated",
  },
  {
    sheet: "sales",
    question: "which columns have outliers",
    expect: ["No outliers — every numeric value in the 8 rows is inside its fence."],
    note: "units (fence [-10, 30]) and revenue are both clean; text columns never appear",
  },
  {
    sheet: "employees",
    question: "how many outliers in salary",
    expect: ["No outliers in salary", "[79,000, 107,000]"],
    note: "salaries 88,000, 91,000, 95,000, 98,000 (NA skipped): Q1 = 89,500, Q3 = 96,500, fence [79,000, 107,000]",
  },
  {
    sheet: "employees",
    question: "how many outliers in salaries",
    expect: ["No outliers in salary", "[79,000, 107,000]"],
    note: "same fence as the singular phrasing — '-ies' plurals resolve to the column",
  },
  {
    sheet: "sales",
    question: "how many outliers in region",
    expect: "abstain",
    note: "outliers need a numeric column — region is text",
  },
  {
    sheet: "scores",
    question: "how many outliers in score by subject",
    expect: "abstain",
    note: "an outlier question is one column, ungrouped — must not answer the whole-sheet count",
  },
  {
    sheet: "duplicates",
    question: "how many duplicate rows",
    expect: ["3 of 7 rows are exact duplicates of an earlier row", "product: 4 duplicate rows"],
    note: "rows 3 and 6 repeat row 1, row 5 repeats row 2 — 3 exact duplicates; product leads the column report",
  },
  {
    sheet: "duplicates",
    question: "how many duplicate products",
    expect: ["4 of 7 rows are duplicates in product (57.14%)", "2 values appear more than once"],
    note: "Widget A 3 times and Widget B 3 times: 2 + 2 = 4 duplicate rows over 2 repeated values",
  },
  {
    sheet: "duplicates",
    question: "how many duplicate regions",
    expect: ["3 of 7 rows are duplicates in region (42.86%)"],
    note: "North 3 times and South twice: 2 + 1 = 3 duplicate rows",
  },
  {
    sheet: "duplicates",
    question: "show duplicate rows",
    expect: ["3 rows that are exact duplicates of an earlier row", "North | Widget A | 12"],
    note: "the three exact duplicate rows, in sheet order — row 3 repeats row 1",
  },
  {
    sheet: "duplicates",
    question: "show duplicates in product",
    expect: ["4 rows that are duplicates in product", "West | Widget B | 3"],
    note: "rows 3, 5, 6 and 7 are duplicates in product — the West row is the second Widget B repeat",
  },
  {
    sheet: "duplicates",
    question: "which columns have duplicates",
    expect: ["Duplicates by column", "units: 3 duplicate rows"],
    note: "the whole-sheet report lists every column, most duplicates first",
  },
  {
    sheet: "sales",
    question: "how many duplicate rows",
    expect: ["No exact duplicate rows", "product: 4 duplicate rows", "region: 4 duplicate rows"],
    note: "sales has no exact duplicate row, but Widget A/Widget B repeat (4 rows) and North/South/East repeat (4 rows)",
  },
  {
    sheet: "sales",
    question: "how many duplicate units",
    expect: ["No duplicates in units — every value appears once (7 of 8 had a value)"],
    note: "units 12, 8, 3, 20, 5, 15, 9 are all distinct; one row is blank",
  },
  {
    sheet: "duplicates",
    question: "how many duplicate products by region",
    expect: "abstain",
    note: "a duplicate question is one column, ungrouped — must not answer the whole-sheet count",
  },
  {
    sheet: "duplicates",
    question: "how many duplicate profit",
    expect: "abstain",
    note: "no profit column",
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
  scores: "scores.csv",
  duplicates: "duplicates.csv",
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
