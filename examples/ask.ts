/**
 * Demo: ask the bundled sample sheets a few questions and print the
 * answers. Run with `npm run demo` (tsx) — no build step needed.
 *
 *   npm run demo
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCsv } from "../src/csv.js";
import { answerQuestion } from "../src/answer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sales = parseCsv(readFileSync(join(root, "examples", "sales.csv"), "utf8"));
const staff = parseCsv(readFileSync(join(root, "examples", "employees.csv"), "utf8"));
const monthly = parseCsv(readFileSync(join(root, "examples", "monthly-sales.csv"), "utf8"));
const scores = parseCsv(readFileSync(join(root, "examples", "scores.csv"), "utf8"));
const duplicates = parseCsv(readFileSync(join(root, "examples", "duplicates.csv"), "utf8"));

const QUESTIONS: [string, ReturnType<typeof parseCsv>][] = [
  ["total revenue", sales],
  ["average revenue", sales],
  ["total revenue by region", sales],
  ["total revenue by region and product", sales],
  ["top 2 region and product by revenue", sales],
  ["top 3 products by revenue", sales],
  ["bottom 3 products by revenue", sales],
  ["how many rows where region is North", sales],
  ["average salary by department", staff],
  ["how many employees in Engineering", staff],
  ["lowest salary", staff],
  ["correlation between revenue and units", sales],
  ["compare revenue Jan 2026 vs Feb 2026", monthly],
  ["what share of revenue is North", sales],
  ["list unique regions", sales],
  ["most common product", sales],
  ["how many distinct regions", sales],
  ["90th percentile of salary", staff],
  ["total revenue where revenue between 100 and 200", sales],
  ["total revenue where region is North and product is Widget A", sales],
  ["how many rows where region is North and revenue > 100", sales],
  ["total revenue where region is North or South", sales],
  ["what share of revenue is North or South", sales],
  ["total revenue excluding North", sales],
  ["total revenue for North and South", sales],
  ["distribution of salary", staff],
  ["histogram of score", scores],
  ["revenue trend by month", monthly],
  ["show rows sorted by revenue descending", sales],
  ["rows with revenue above average", sales],
  ["how many rows are missing units", sales],
  ["which columns have missing values", sales],
  ["show rows missing salary", staff],
  ["how many rows are missing salaries", staff],
  ["how many outliers in score", scores],
  ["which columns have outliers", scores],
  ["show outliers in score", scores],
  ["how many duplicate rows", duplicates],
  ["how many duplicate products", duplicates],
  ["show duplicate rows", duplicates],
  ["second highest salary", staff],
  ["3rd lowest revenue", sales],
  ["3rd highest hours", scores],
  ["5th highest salary", staff],
  ["second highest total revenue by region", sales],
  ["which region has the second highest total revenue", sales],
  ["which region has the highest total revenue", sales],
  ["which product has the lowest average units", sales],
  ["which department has the highest median salary", staff],
  ["compare total revenue in North vs South", sales],
  ["compare average salary in Engineering vs Data", staff],
  ["compare rows in North vs South", sales],
  // And one the engine must refuse to guess at:
  ["total profit", sales],
];

for (const [question, sheet] of QUESTIONS) {
  console.log(`Q: ${question}`);
  console.log(`A: ${answerQuestion(question, sheet)}\n`);
}
