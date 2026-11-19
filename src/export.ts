/**
 * Result export: write a structured {@link QueryResult} to a file so
 * an answer can be opened in a spreadsheet, piped into another tool,
 * or kept as a record. Two formats:
 *
 * - JSON: the same `{ question, answer, result }` object `sheet ask
 *   --json` prints.
 * - CSV: one table per result kind. Groups become
 *   `<group-by>,<column>,rows` (e.g. `region,revenue,rows`); row
 *   results keep their headers; a scalar becomes one row of
 *   `label,value,rows_matched,values_used`; a correlation becomes
 *   one row of `column_a,column_b,correlation,paired_rows,rows_matched`
 *   (empty correlation when it could not be computed); a comparison
 *   becomes one row per period plus `change` and `percent_change`
 *   rows (empty when the comparison could not be computed).
 *   An abstention (no result) exports as a single `question,answer` row — the file still says
 *   what happened instead of being silently empty.
 */

import type { QueryResult } from "./engine.js";

/** RFC 4180 field escaping: quote when the value needs it. */
export function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: string[]): string {
  return values.map(csvCell).join(",");
}

/**
 * Render a query result as CSV text (no trailing newline — callers
 * add one when writing the file).
 */
export function resultToCsv(
  result: QueryResult,
  question: string,
  answer: string,
): string {
  switch (result.kind) {
    case "scalar":
      return [
        csvRow(["label", "value", "rows_matched", "values_used"]),
        csvRow([
          result.label,
          result.value === null ? "" : String(result.value),
          String(result.rowsMatched),
          String(result.valuesUsed),
        ]),
      ].join("\n");
    case "groups": {
      const valueHeader = result.column ?? "count";
      const lines = [csvRow([result.groupBy, valueHeader, "rows"])];
      for (const g of result.groups) {
        lines.push(csvRow([g.key, String(g.value), String(g.count)]));
      }
      return lines.join("\n");
    }
    case "rows": {
      const lines = [csvRow(result.headers)];
      for (const row of result.rows) {
        lines.push(csvRow(result.headers.map((h) => row[h] ?? "")));
      }
      return lines.join("\n");
    }
    case "correlation":
      return [
        csvRow(["column_a", "column_b", "correlation", "paired_rows", "rows_matched"]),
        csvRow([
          result.columnA,
          result.columnB,
          result.value === null ? "" : String(result.value),
          String(result.pairs),
          String(result.rowsMatched),
        ]),
      ].join("\n");
    case "comparison": {
      const periodRow = (p: { label: string; value: number | null; rows: number; valuesUsed: number }) =>
        csvRow([
          p.label,
          p.value === null ? "" : String(p.value),
          String(p.rows),
          String(p.valuesUsed),
        ]);
      return [
        csvRow(["period", "value", "rows", "values_used"]),
        periodRow(result.periodA),
        periodRow(result.periodB),
        csvRow(["change", result.delta === null ? "" : String(result.delta), "", ""]),
        csvRow([
          "percent_change",
          result.pctChange === null ? "" : String(result.pctChange),
          "",
          "",
        ]),
      ].join("\n");
    }
  }
}

/** CSV for an abstention: the question and the answer, nothing else. */
export function abstentionToCsv(question: string, answer: string): string {
  return [csvRow(["question", "answer"]), csvRow([question, answer])].join("\n");
}

/** The export format for a file path: `.json`, `.csv`, or null. */
export function exportFormat(path: string): "json" | "csv" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}
