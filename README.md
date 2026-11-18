# Spreadsheet Analyst

Chat with your CSVs — ask questions in plain English and get answers
computed from the data, with the numbers to back them up. No LLM key
needed for the local engine: an offline, deterministic query engine
answers descriptive questions (counts, sums, averages, filters, groups,
top-N) directly from the spreadsheet.

> **Status:** in progress (project #39 of the portfolio program).

## Roadmap

- [x] Project scaffold (README roadmap, license, gitignore, CI)
- [x] CSV ingestion (RFC 4180 parser, quoted fields, ragged rows, encoding)
- [x] Schema inference (number / date / boolean / text, nulls, samples)
- [x] Descriptive statistics (count, mean, median, min/max, distinct)
- [x] Natural-language query engine (filter, aggregate, group-by, top-N)
- [x] Answer composer (cited numbers, honest "not in the data" handling)
- [x] CLI (`sheet ask`, `sheet describe`, `sheet columns`)
- [x] Eval harness (gold question set, accuracy + abstention metrics)
- [x] Multi-sheet workbooks (XLSX via sheet names, CSV directory import)
- [x] Charts (ASCII + SVG output for distributions and trends)
- [ ] Self-review checklist, then public

## Quick start

```bash
npm install
npm run build
npm test
```

## Ingestion & schema

`parseCsv` (in `src/csv.ts`) implements RFC 4180: quoted fields may
contain commas and newlines, `""` unescapes to `"`, CRLF/LF/CR endings
and a UTF-8 BOM are handled, and an unterminated quote fails loudly
with `CsvParseError`. Duplicate or empty headers are disambiguated
(`name_2`, `column_3`) and short rows are padded with `""`.

`inferSchema` (in `src/schema.ts`) guesses each column's type —
`boolean`, `integer`, `number`, `date` (ISO or day-first DD/MM/YYYY),
`text`, or `empty` — treating `""`, `null`, `NA`, `N/A` and `-` as
missing. It also reports null counts, distinct counts and samples.

## Descriptive statistics

`describe` (in `src/stats.ts`) summarizes every column: numeric
columns get count, min/max, sum, mean, median and population stddev
(dates are summarized as epoch ranges); text and boolean columns get
their top 10 values by frequency, with ties broken alphabetically.
Try it on the bundled samples in `examples/` (`sales.csv`,
`employees.csv`).

## Asking questions

`parseQuestion` (in `src/query.ts`) turns a plain-English question into
a structured query, `executeQuery` (in `src/engine.ts`) runs it, and
`composeAnswer` (in `src/answer.ts`) renders the answer — or use
`answerQuestion(question, parsed)` for all three in one call. The engine
is deterministic and offline: no LLM, no guessing. Try it on the bundled
samples with `npm run demo` (`examples/ask.ts`).

```ts
import { parseCsv } from "./src/csv.js";
import { answerQuestion } from "./src/answer.js";

const sales = parseCsv(await readFile("examples/sales.csv", "utf8"));
answerQuestion("total revenue", sales);
// "Total revenue is 1,789.6 (across 8 rows)."
answerQuestion("total revenue by region", sales);
// "Total revenue by region:\n- South: 649.77 (2 rows)\n- East: 624.91 (2 rows)…"
answerQuestion("top 3 products by revenue", sales);
// "Top 3 of 4 groups:\n- Widget A: 640 (3 rows)…"
answerQuestion("total profit", sales);
// "I can't answer that from this data: no column named in the question…"
```

Supported shapes: totals, averages, medians, minimums, maximums
("total revenue", "average salary"), counts ("how many employees"),
group-by ("total revenue by region", "average salary per department"),
top-N ("top 3 products by revenue", "highest revenue" = top 1), filters
("total revenue where region is North", "average salary where salary >
90000", "sales in North"), and row queries ("show rows where region is
North"). Filters compare numbers numerically, dates by day, and text
case-insensitively. Aggregates skip null values and say so when some
matching rows had no usable value; a column with no usable values at
all is reported as such, never rendered as zero. When a question cannot
be understood unambiguously — unknown or ambiguous column, a value that
belongs to several columns — the parser abstains with a reason instead
of answering a different question.

## Command-line interface

```bash
npm run build
node dist/cli.js columns examples/sales.csv
node dist/cli.js describe examples/employees.csv
node dist/cli.js ask examples/sales.csv "total revenue by region"
```

Or install it once (`npm install -g .` from the repo root, or
`npm link`) and use `sheet` directly. Every command accepts `--json`
for machine-readable output; `sheet --help` lists all commands.

- `sheet columns <file>` — one line per column: inferred type, null
  count, distinct count, samples. JSON output is the schema array.
- `sheet describe <file>` — per-column statistics: numeric columns
  get count, min/max, mean, median and population stddev; date
  columns get their range and median date (never epoch sums); text
  and boolean columns get their most common values.
- `sheet ask <file> <question>` — the composed answer, or an honest
  "I can't answer that" when the question cannot be understood from
  this sheet. Quoting the question is optional. JSON output is
  `{ question, answer, result }`, with `result: null` on abstention.
- `sheet sheets <directory>` — list the sheets of a workbook, one
  line per sheet with its row count.

### Workbooks (multi-sheet)

A directory of CSVs is one workbook — one sheet per file, named
after the file (`examples/` is a workbook with sheets `employees`
and `sales`). Every command accepts a directory where it accepts a
file:

```bash
node dist/cli.js sheets examples
node dist/cli.js ask examples "total revenue in sales"
node dist/cli.js ask examples "average salary" --sheet employees
node dist/cli.js describe examples --sheet sales
```

Sheet routing for `ask`: `--sheet <name>` wins; otherwise a
trailing `in|from|on <sheet>` clause in the question picks the sheet;
a one-sheet workbook needs no choice. When a multi-sheet workbook
gets a question that names no sheet, the answer is an honest
abstention listing the sheets — the engine never guesses. `columns`
and `describe` on a multi-sheet workbook without `--sheet` exit `2`
with the same list. Duplicate sheet names get a `_2` suffix rather
than dropping a file.

Exit codes: `0` success (an abstention still exits `0` — the question
was answered, just not from this data), `1` unreadable file or
malformed CSV, `2` usage error (unknown command, missing argument or
flag).

### Charts

`sheet chart <file> <question>` asks the question and draws the
answer as an ASCII bar chart — but only group-by answers chart
(e.g. `"total revenue by region"`). A scalar or row answer prints the
answer with a note that there is nothing to chart, and an abstention
prints the abstention: the chart never invents a picture for an
answer that has none. Bars are proportional to the largest value and
every value is printed next to its bar, so a zero group is visible
as an empty bar with its `0`.

```bash
node dist/cli.js chart examples/sales.csv "total revenue by region"
node dist/cli.js chart examples/sales.csv "total revenue by region" --svg revenue-by-region.svg
```

`--svg <path>` also writes the chart as a standalone SVG document
(group names are XML-escaped). `describe` prints a one-line
distribution sparkline under each numeric column, so skew and
clustering are visible at a glance. The chart helpers
(`renderBarChart`, `histogram`, `sparkline`, `renderBarChartSvg`)
are exported from the package for programmatic use.

## Evaluation

`npm run eval` scores the engine against a 19-question gold set over
the bundled samples (`src/eval.ts`, `GOLD_SET`): totals, averages,
medians, group-bys, top-N, filters and row queries, plus three
questions the honest answer is an abstention for (unknown column,
unanswerable question). Expected values are hand-computed from the
CSVs, never derived from the code under test.

Baseline (2026-11-18): answer accuracy 16/16 (100%), abstention
accuracy 3/3 (100%), overall 100%. The run exits non-zero below an
80% overall-accuracy gate, and CI runs it after the test suite — so a
parser or engine change that breaks a question that used to work
fails the build. The eval caught a real bug on its first run: row
answers printed raw cell text (`98000`) while scalar answers format
numbers (`98,000`); `composeAnswer` now formats numeric columns in
row tables too (see `tests/answer.test.ts`).

## License

MIT
