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
export {
  askWorkbook,
  askWorkbookDetailed,
  explainWorkbook,
  getSheet,
  listSheets,
  loadWorkbookFromDir,
  loadWorkbookFromFiles,
  sheetNameFromPath,
  WorkbookError,
  type Workbook,
} from "./workbook.js";
export {
  histogram,
  renderBarChart,
  renderBarChartSvg,
  renderHistogram,
  renderLineChart,
  renderLineChartSvg,
  renderResultChart,
  renderResultChartSvg,
  sparkline,
  type Bar,
  type BarChartOptions,
  type HistogramBin,
  type LineChartOptions,
  type SvgChartOptions,
} from "./charts.js";
export {
  iqrOutliers,
  profileColumn,
  profileSheet,
  type ColumnProfile,
  type OutlierSummary,
  type SheetProfile,
} from "./profile.js";
export {
  bucketDate,
  isoWeek,
  parseDate,
  type DateBucket,
  type ParsedDate,
  type TimeBucket,
} from "./time.js";
export {
  describeQuery,
  explainQuestion,
  formatExplainText,
  type ExplainResult,
} from "./explain.js";
export {
  abstentionToCsv,
  csvCell,
  exportFormat,
  resultToCsv,
} from "./export.js";
