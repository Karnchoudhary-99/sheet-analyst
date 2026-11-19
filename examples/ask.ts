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

const QUESTIONS: [string, ReturnType<typeof parseCsv>][] = [
  ["total revenue", sales],
  ["average revenue", sales],
  ["total revenue by region", sales],
  ["top 3 products by revenue", sales],
  ["how many rows where region is North", sales],
  ["average salary by department", staff],
  ["how many employees in Engineering", staff],
  ["lowest salary", staff],
  ["correlation between revenue and units", sales],
  ["compare revenue Jan 2026 vs Feb 2026", monthly],
  ["what share of revenue is North", sales],
  ["list unique regions", sales],
  // And one the engine must refuse to guess at:
  ["total profit", sales],
];

for (const [question, sheet] of QUESTIONS) {
  console.log(`Q: ${question}`);
  console.log(`A: ${answerQuestion(question, sheet)}\n`);
}
