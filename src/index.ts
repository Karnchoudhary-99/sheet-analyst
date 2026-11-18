// Spreadsheet Analyst — public entry point.
export const VERSION = "0.1.0";

export { parseCsv, toRecords, CsvParseError, type ParsedCsv } from "./csv.js";
export { inferSchema, isNullValue, type ColumnInfo, type ColumnType } from "./schema.js";
export { describe, describeColumn, numericStats, type ColumnStats } from "./stats.js";
export {
  parseQuestion,
  normalize,
  findColumns,
  type Query,
  type Filter,
  type FilterOp,
  type AggregateOp,
  type ParseResult,
} from "./query.js";
export { executeQuery, applyFilters, type QueryResult } from "./engine.js";
export {
  answerQuestion,
  composeAnswer,
  composeAbstention,
  formatNumber,
} from "./answer.js";
