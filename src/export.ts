/**
 * Result export: write a structured {@link QueryResult} to a file so
 * an answer can be opened in a spreadsheet, piped into another tool,
 * or kept as a record. Two formats:
 *
 * - JSON: the same `{ question, answer, result }` object `sheet ask
 *   --json` prints.
 * - CSV: one table per result kind. Groups become one column per
 *   group-by column plus `<column>,rows` (e.g. `region,product,
 *   revenue,rows`); row results keep their headers; a scalar
 *   becomes one row of `label,value,rows_matched,values_used`; a correlation becomes
 *   one row of `column_a,column_b,correlation,paired_rows,rows_matched`
 *   (empty correlation when it could not be computed); a comparison
 *   becomes one row per period plus `change` and `percent_change`
 *   rows (empty when the comparison could not be computed); a share
 *   becomes one row of
 *   `label,share,subset_value,total_value,subset_rows,total_rows`
 *   where `share` is the fraction (0.35 for 35%, empty when the
 *   total is zero) and `label` is `total <column>` or `rows`.
 *   Distinct values become one row per value of `value,rows`.
 *   A mode becomes one row of `column,value,rows,distinct_values,
 *   rows_matched` (empty value when the column has no usable values).
 *   An abstention (no result) exports as a single `question,answer` row — the file still says
 *   what happened instead of being silently empty.
 *   A trend becomes one row per period of `period,value,rows,values_used`
 *   plus a `slope per <bucket>` row (empty slope when the trend could
 *   not be computed, empty value for a period with no usable values).
 *   An above/below-average result exports as its row table, like a
 *   row listing — the threshold is in the answer text, not the CSV.
 *   Missing values become one row per column of
 *   `column,missing_rows,total_rows,percent_missing` (the fraction,
 *   0.125 for 12.5%); a single-column question exports just that
 *   column's row.
 *   Outliers become one row per column of
 *   `column,outliers,total_rows,percent_outliers,low_bound,high_bound`
 *   (the fraction, 0.125 for 12.5%; empty bounds when fewer than 4
 *   usable values, so no fence exists); a single-column question
 *   exports just that column's row.
 *   Duplicates become one row per column of
 *   `column,duplicate_rows,total_rows,percent_duplicates,values_with_duplicates`
 *   (the fraction, 0.5714 for 57.14%); a whole-sheet report adds a
 *   leading row for the exact duplicate rows
 *   (`(full rows),duplicate_rows,total_rows,percent_duplicates,`
 *   with no values-with-duplicates — a full row is not a value);
 *   a single-column question exports just that column's row.
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
      // One column per group-by column, so a composite group splits
      // back into its parts instead of arriving as one joined label.
      const lines = [csvRow([...result.groupBy, valueHeader, "rows"])];
      for (const g of result.groups) {
        lines.push(csvRow([...g.keys, String(g.value), String(g.count)]));
      }
      return lines.join("\n");
    }
    case "rows":
    case "aboveBelow": {
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
    case "share":
      return [
        csvRow(["label", "share", "subset_value", "total_value", "subset_rows", "total_rows"]),
        csvRow([
          result.column ? `total ${result.column}` : "rows",
          result.share === null ? "" : String(result.share),
          String(result.subsetValue),
          String(result.totalValue),
          String(result.subsetRows),
          String(result.totalRows),
        ]),
      ].join("\n");
    case "values": {
      const lines = [csvRow(["value", "rows"])];
      for (const v of result.values) {
        lines.push(csvRow([v.value, String(v.count)]));
      }
      return lines.join("\n");
    }
    case "mode":
      return [
        csvRow(["column", "value", "rows", "distinct_values", "rows_matched"]),
        csvRow([
          result.column,
          result.value ?? "",
          String(result.count),
          String(result.totalDistinct),
          String(result.rowsMatched),
        ]),
      ].join("\n");
    case "trend": {
      const lines = [csvRow(["period", "value", "rows", "values_used"])];
      for (const p of result.periods) {
        lines.push(
          csvRow([
            p.label,
            p.value === null ? "" : String(p.value),
            String(p.rows),
            String(p.valuesUsed),
          ]),
        );
      }
      lines.push(
        csvRow([
          `slope per ${result.bucket}`,
          result.slope === null ? "" : String(result.slope),
          "",
          "",
        ]),
      );
      return lines.join("\n");
    }
    case "missing": {
      const lines = [csvRow(["column", "missing_rows", "total_rows", "percent_missing"])];
      for (const e of result.entries) {
        lines.push(
          csvRow([
            e.column,
            String(e.missing),
            String(e.total),
            e.total === 0 ? "" : String(e.missing / e.total),
          ]),
        );
      }
      return lines.join("\n");
    }
    case "outliers": {
      const lines = [
        csvRow(["column", "outliers", "total_rows", "percent_outliers", "low_bound", "high_bound"]),
      ];
      for (const e of result.entries) {
        lines.push(
          csvRow([
            e.column,
            String(e.outliers),
            String(e.total),
            e.total === 0 ? "" : String(e.outliers / e.total),
            e.lowBound === null ? "" : String(e.lowBound),
            e.highBound === null ? "" : String(e.highBound),
          ]),
        );
      }
      return lines.join("\n");
    }
    case "duplicates": {
      const lines = [
        csvRow([
          "column",
          "duplicate_rows",
          "total_rows",
          "percent_duplicates",
          "values_with_duplicates",
        ]),
      ];
      // A whole-sheet report leads with the exact duplicate rows —
      // the headline number the answer opens with — before the
      // per-column rows.
      if (result.column === null) {
        lines.push(
          csvRow([
            "(full rows)",
            String(result.duplicateRows),
            String(result.rowsMatched),
            result.rowsMatched === 0
              ? ""
              : String(result.duplicateRows / result.rowsMatched),
            "",
          ]),
        );
      }
      for (const e of result.entries) {
        lines.push(
          csvRow([
            e.column,
            String(e.duplicates),
            String(e.total),
            e.total === 0 ? "" : String(e.duplicates / e.total),
            String(e.valuesWithDuplicates),
          ]),
        );
      }
      return lines.join("\n");
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
