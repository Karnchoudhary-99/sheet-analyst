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
- [x] CLI (`sheet ask`, `sheet describe`, `sheet columns`, `sheet profile`)
- [x] Eval harness (gold question set, accuracy + abstention metrics)
- [x] Multi-sheet workbooks (XLSX via sheet names, CSV directory import)
- [x] Charts (ASCII + SVG output for distributions and trends)
- [x] Time-series grouping (by day/week/month/quarter/year + line charts)
- [x] Data-quality profile (null rates, duplicates, empty rows, constant columns, whitespace, IQR outliers)
- [x] Query explanation + result export (`sheet explain`, `ask --out` .json/.csv)
- [x] Correlation + quartiles (Pearson r questions, Q1/Q3 in `describe`)
- [x] Period comparison (change/growth between two named months, quarters or years)
- [x] Share / percentage-of-total questions (subset total vs whole-sheet total, row-count share)
- [x] Distinct-values listing (every distinct value with row counts, most frequent first)
- [x] Multi-column group-by ("by region and product", up to three columns, composite keys, CSV export splits them)
- [x] Mode + distinct-count questions ("most common product", "how many distinct regions", blanks excluded, alphabetical tie-break)
- [x] Percentile questions + `between` range filters ("90th percentile of salary", "p90 revenue", "where revenue between 100 and 200", inclusive, smaller value first)
- [x] Trend questions ("revenue trend by month" — least-squares slope per period, up/down/roughly-flat wording, line chart, periods with no usable value named, not zero-filled)
- [x] Bottom-N questions ("bottom 3 products by revenue", "bottom 2 months by revenue" — the low end of the top-N ranking, smallest first, headed "Bottom N of M" instead of "Top N")
- [x] Sorted row listings ("show rows sorted by revenue descending", "list employees sorted by salary ascending" — numbers numerically, dates by day, text alphabetically; blank cells always last; the sort runs before the limit, so the first N of a sorted listing are the sorted top N)
- [x] Above/below-average questions ("rows with revenue above average", "which employees have salary below the median" — rows strictly on one side of the column's mean or median; equal-to-baseline rows are neither; a column with no usable value has no baseline and the answer says so)
- [x] Missing-values questions ("how many rows are missing salary", "which columns have missing values" — a count per column or a whole-sheet report, worst first; "show rows missing revenue" lists the rows; empty and NA markers count as missing, a zero never does)
- [x] Outlier questions ("how many outliers in score", "which columns have outliers" — a count per column or a whole-sheet report over numeric columns, worst first; "show outliers in score" lists the rows; Tukey IQR fence, the same fence the data-quality profile reports)
- [x] Duplicate questions ("how many duplicate rows", "which columns have duplicates" — a count per column or a whole-sheet report over every column, worst first, plus the exact duplicate rows; "show duplicate rows" / "show duplicates in product" lists the rows; a repeated value is counted from its second occurrence, blanks never count as duplicates)
- [x] Ordinal-rank questions ("second highest salary", "3rd lowest revenue" — the nth distinct value from the top or the bottom of one numeric column; ties share the rank, so the answer also says how many rows hold that value; a rank past the end says so instead of falling back to the last value)
- [x] Compound filters ("total revenue where region is North and product is Widget A", "how many rows where revenue > 100 and units < 10" — every condition must hold; a between-range keeps its own "and"; an unknown column in any condition abstains naming it; an "and" inside a value is left alone)
- [x] Or filters ("total revenue where region is North or South", "how many rows where revenue > 400 or revenue < 130" — at least one branch must hold; AND binds tighter, so "a and b or c" is (a and b) or c; a bare value inherits the most recent "=" filter; an "or" inside a quoted value is left alone; an unknown column in any branch abstains naming it; share questions take "or" subsets too)
- [x] Exclusion filters ("total revenue excluding North", "total revenue except Widget A" — a "!=" filter on the owning column; several values exclude several; composes with "in" and with a where clause placed after it; an unknown or multi-column value abstains)
- [x] Trailing value lists ("total revenue for North and South", "total revenue in North or South" — a list after "in"/"for" is an "or"; a single unknown trailing value abstains instead of answering the whole sheet)
- [x] Did-you-mean hints ("total revnue" suggests "revenue", "total revenue by regoin" suggests "region" — edit distance ≤ 2 or a prefix; a group-by naming no column is now an error instead of silently answering the plain total)
- [x] Distribution questions ("distribution of salary", "histogram of revenue" — values binned into an equal-width histogram, at most 10 bins and never more than the distinct-value count; a text column abstains; `sheet chart` draws it, `ask --out` exports one CSV row per bin)
- [x] Cross-column comparisons ("how many rows where revenue is greater than units", "total score where score is greater than hours" — a where clause may compare two columns in the same row with `>`, `>=`, `<` or `<=`; both must be numbers or both dates, a blank cell on either side never matches, `=` and quoted right-hand sides stay literal)
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
columns get count, min/max, quartiles (Q1/median/Q3 by linear
interpolation), sum, mean and population stddev (dates are summarized
as epoch ranges); text and boolean columns get their top 10 values by
frequency, with ties broken alphabetically. Try it on the bundled
samples in `examples/` (`sales.csv`, `employees.csv`).

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
const monthlySales = parseCsv(await readFile("examples/monthly-sales.csv", "utf8"));
answerQuestion("total revenue", sales);
// "Total revenue is 1,789.6 (across 8 rows)."
answerQuestion("total revenue by region", sales);
// "Total revenue by region:\n- South: 649.77 (2 rows)\n- East: 624.91 (2 rows)…"
answerQuestion("top 3 products by revenue", sales);
// "Top 3 of 4 groups:\n- Widget A: 640 (3 rows)…"
answerQuestion("bottom 3 products by revenue", sales);
// "Bottom 3 of 4 groups:\n- Widget, Deluxe: 149.97 (1 row)…"
answerQuestion("show rows sorted by revenue descending", sales);
// "8 matching rows, sorted by revenue (descending):\n| date | region | product | units | revenue |…"
// (numbers sort numerically, dates by day, text alphabetically;
// blank cells always sort last; no direction means ascending)
answerQuestion("rows with revenue above average", sales);
// "4 rows have revenue above the average of 223.7:\n| date | region | product | units | revenue |…"
answerQuestion("total revenue where region is North or South", sales);
// "Total revenue is 1,039.74 (across 5 rows)."
// (at least one branch must hold; AND binds tighter, so
// "region is North or South and product is Widget A" is
// (North) or (South and Widget A); a bare value inherits the
// most recent "=" filter)
answerQuestion("how many rows are missing units", sales);
// "1 of 8 rows is missing units (12.5%)."
answerQuestion("which columns have missing values", sales);
// "Missing values (8 rows):\n- units: 1 of 8 rows missing (12.5%)\n- date: 0 of 8 rows missing (0%)…"
answerQuestion("show rows missing units", sales);
// "1 row missing units:\n| date | region | product | units | revenue |…"
answerQuestion("total profit", sales);
// "I can't answer that from this data: no column named in the question…"
answerQuestion("how many rows where revenue is greater than units", sales);
// "There are 7 matching rows." (the blank-units row drops out —
// a missing value is never greater than, or less than, anything)
answerQuestion("total revenue where revenue is greater than units", sales);
// "Total revenue is 1,789.6 (across 7 rows)."
// A where clause may compare two columns in the same row instead
// of a column against a literal, with `>`, `>=`, `<` or `<=`
// ("where score is greater than hours"). Both columns must be
// numbers, or both dates — a number against a date, or text
// against text, abstains instead of answering. `=` never takes
// this path ("where region is revenue" means a region literally
// called revenue), and neither does a quoted right-hand side.
answerQuestion("total revenue by month", monthlySales);
// "Total revenue by month:\n- Jan 2026: 664.91 (4 rows)\n- Feb 2026: 914.81 (4 rows)…"
answerQuestion("correlation between revenue and units", sales);
// "The correlation between revenue and units is 0.90 (strong positive) across 7 paired rows."
answerQuestion("compare revenue Jan 2026 vs Feb 2026", monthlySales);
// "Total revenue grew from 664.91 in Jan 2026 to 914.81 in Feb 2026 (+249.9, +37.58%)."
answerQuestion("what share of revenue is North", sales);
// "Region is North accounts for 21.79% of total revenue (389.97 of 1,789.6, from 3 of 8 rows)."
answerQuestion("what percentage of rows are in North", sales);
// "3 of 8 rows (37.5%) match region is North."
answerQuestion("list unique regions", sales);
// "Distinct region (4 values):\n- North: 3 rows\n- East: 2 rows…"
```

Column names can be written in the plural — `"how many rows are
missing salaries"`, `"how many outliers in revenues"`, `"what share
of revenues is North"` all resolve to the `salary` / `revenue`
column, including `-ies` plurals (`salaries` → `salary`). Multi-word
names pluralise their last word (`"start dates"`).

Time grouping (`src/time.ts`) collapses the sheet's date column
into periods — `"total revenue by month"`, `"average salary by
year"`, `"top 2 months by revenue"`, `"how many rows by quarter"`.
Periods are day, week (ISO-8601, keyed on the week-year), month,
quarter and year, with aliases (`daily`, `weekly`, `monthly`,
`quarterly`, `yearly`, `annual`). Time groups list chronologically,
not largest-first, and rows whose date is blank or unparseable land
in a trailing `(no date)` group instead of being dropped silently.
A period the engine cannot bucket (`"by decade"`) abstains with a
reason rather than answering the plain total, and a `"by month"`
clause on a sheet with no date column — or on a non-date column
(`"total revenue by region by month"`) — abstains too.

Supported shapes: totals, averages, medians, minimums, maximums
("total revenue", "average salary"), counts ("how many employees"),
group-by ("total revenue by region", "average salary per department"),
multi-column group-by ("total revenue by region and product",
"how many employees by department and remote" — up to three columns,
in the order named, comma-separated too), top-N ("top 3 products by
revenue", "top 3 region and product by revenue", "highest revenue" =
top 1) and bottom-N ("bottom 3 products by revenue", "bottom 2 months
by revenue", "bottom revenue" = the single lowest row — the same
ranking, smallest first, headed "Bottom N of M" instead of "Top N"), filters
("total revenue where region is North", "average salary where salary >
90000", "sales in North"), compound filters ("total revenue where region
is North and product is Widget A", "how many rows where revenue > 100 and
units < 10" — every condition must hold; a between-range keeps its own
"and", and an "and" inside a value is left alone), or filters ("total
revenue where region is North or South", "how many rows where revenue >
400 or revenue < 130" — at least one branch must hold; AND binds tighter,
so "a and b or c" is (a and b) or c; a bare value inherits the most recent
"=" filter — "region is North or South" — and an "or" inside a quoted
value is left alone; share questions take "or" subsets too — "what share
of revenue is North or South"), row queries ("show rows where region is
North"), sorted row listings ("show rows sorted by revenue
descending", "list employees sorted by salary ascending" — the sort
runs before the limit, so the first N rows are the sorted top N),
above/below-average questions ("rows with revenue above average",
"which employees have salary below the median" — strictly on one
side of the column's mean or median),
correlation ("correlation between revenue and units",
"how correlated are salary and age"), period comparison
("compare revenue Jan 2026 vs Feb 2026", "revenue change from
January to February", "compare rows in Jan vs Feb"), and share
("what share of revenue is North", "what percentage of total revenue
comes from North", "what share of rows are in North"), and distinct
values ("list unique regions", "what are the distinct products"),
mode ("most common product", "what is the mode of region") and
distinct count ("how many distinct regions", "count distinct
products"), distribution ("distribution of salary", "histogram of
revenue" — values binned into an equal-width histogram, at most 10
bins and never more than the distinct-value count; `sheet chart`
draws it), percentile ("90th percentile of salary", "p90 revenue")
and range filters ("total revenue where revenue between 100 and
200" — inclusive on both ends, the smaller value first; a reversed
range abstains instead of answering "no rows"), rank ("second
highest salary", "3rd lowest revenue" — the nth distinct value from
the top or the bottom of one numeric column; ties share the rank),
and trend
("revenue trend by month", "average salary trend by year" — the
least-squares slope of the per-period aggregate, so "trended up by
about 84.95 per month"; a trend needs a period and one numeric
column). Missing-values questions ("how many rows are missing
salary", "which columns have missing values", "show rows missing
revenue") count empty cells and markers like NA as missing — a zero
is a value, never a missing one. A whole-sheet report lists every
column, worst first, so a clean column reads as "0 of 8 rows
missing" instead of being silently absent; a row listing shows the
first 10 rows missing the column.
A distinct-values answer lists every distinct value of the column
with its row count, most frequent first (alphabetical tie-break),
showing the first 20 when there are more; blank cells are never
listed as values. A mode answer names the most frequent value, how
many rows carry it and how many distinct values there are ("The most
common region is North (3 of 8 rows, out of 4 distinct values)");
ties break alphabetically, and a mode is one column, ungrouped
("most common product by region" abstains). A distinct-count answer
is a scalar ("Distinct region values is 4 (across 8 rows)"); blank
cells are never counted as values. A percentile answer interpolates
linearly between the two nearest ranks (the numpy default, the same
method as the quartiles in `describe`): "90th percentile of salary
is 97,100 (across 5 rows, 4 of 5 had a value)"; p = 0 and p = 100
are just the minimum and maximum, so only 1–99 are accepted. A rank
answer names the nth distinct value from the top or the bottom of
one numeric column ("second highest salary", "3rd lowest revenue");
ties share the rank, so the answer also says how many rows hold the
value ("The 2nd highest salary is 95,000 (1 row holds it, out of 4
distinct values)"), and a rank past the end says so instead of
falling back to the last value ("The 5th highest salary does not
exist — there are only 4 distinct salary values"). A rank is one
column, ungrouped ("second highest salary by department" abstains).
A multi-column group-by answer lists one line per
combination ("North · Widget A: 240 (2 rows)"), largest first, and a
blank cell in any group column shows as "(blank)" rather than being
dropped. A time bucket plus a second group column ("by region and
product by month", "by month and region") abstains — group by one
dimension at a time — as does a group word that is not a column
("by region and profit" must not silently answer as "by region").
A share compares
a filtered subset's total against the whole sheet's total — the subset
is named by a `where` clause, a trailing `in`/`for` value, or a trailing
`from`/`is` value ("revenue comes from North", "revenue is North") —
and is always a share of a total, never of an average ("what share of
average revenue is North" abstains with that reason). A whole-sheet
total of zero is reported as uncomputable, never as a 0% share. A
comparison
needs two named periods of the same kind — two months, two quarters
or two years — over the sheet's date column; a bare month name
("January") resolves to the sheet's only year and refuses to guess
when the sheet spans several years. The answer states the delta and
the percent change ("grew from 664.91 in Jan 2026 to 914.81 in Feb
2026 (+249.9, +37.58%)"); a period with no rows, or a zero baseline,
is reported honestly instead of a comparison being invented. A
correlation is the Pearson coefficient over the rows where both
columns have a value (a blank in either column drops that row from
the pairing), reported with a strength word (strong ≥ 0.7, moderate
≥ 0.4, weak ≥ 0.1, negligible below that); fewer than two pairs, or
a constant column, is reported as uncomputable rather than as zero. A
trend fits a least-squares line through the per-period aggregates
and reports the slope per period ("Total revenue trended up by about
84.95 per month over 3 months (from 664.91 in Jan 2026 to 834.81 in
Mar 2026)"); a slope under 1% of the typical period value is
reported as "roughly flat" rather than as a tiny rise or fall, and
periods with no usable value are named in the answer and left out of
the fit at their true position, so a gap period cannot compress the
timeline. With fewer than two periods carrying a usable value there
is no line to fit, and that is said plainly. Filters compare numbers
numerically, dates by day, and text case-insensitively. Aggregates skip
null values and say so when some matching rows had no usable value; a
column with no usable values at all is reported as such, never rendered
as zero. Outliers use the same Tukey IQR fence as the data-quality
profile (1.5 × IQR outside Q1/Q3; fewer than 4 usable values means
no fence). \"how many outliers in score\" counts them (\"1 of 8 rows
is an outlier in score (12.5%) outside [2.75, 20.75] (seen 1,000)\"),
\"which columns have outliers\" reports every numeric column, worst
first, and \"show outliers in score\" lists the rows themselves. A
column with no outliers says so with its fence (\"No outliers in
revenue — every value is inside [-136.35, 593.81]\"), a column with
too few values says so too, and a text column or a grouped question
abstains. The fence is computed over the filtered rows, so
\"outliers in score in Math\" judges only the Math rows. Duplicates
count rows beyond the first occurrence of a repeated value
(\"how many duplicate products\" — \"4 of 7 rows are duplicates in
product (57.14%) — 2 values appear more than once\"), and the
whole-sheet report leads with the exact duplicate rows (\"3 of 7
rows are exact duplicates of an earlier row\") before listing every
column, worst first; \"show duplicate rows\" lists the exact
duplicates themselves. Blank cells are not values, so two blanks
never count as a duplicate, and different spellings (\"North\" vs
\"north\") are different values. When a
question cannot be understood unambiguously — unknown
or ambiguous column, a value that belongs to several columns — the
parser abstains with a reason instead of answering a different question.

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
  get count, min/max, quartiles (Q1/median/Q3), mean and population
  stddev; date columns get their range and median date (never epoch sums);
  text and boolean columns get their most common values.
- `sheet ask <file> <question>` — the composed answer, or an honest
  "I can't answer that" when the question cannot be understood from
  this sheet. Quoting the question is optional. JSON output is
  `{ question, answer, result }`, with `result: null` on abstention.
- `sheet profile <file>` — data-quality report: duplicate and empty
  rows, per-column null rates, constant columns, cells with
  leading/trailing whitespace, and numeric outliers by the Tukey IQR
  fence. JSON output is the profile object.
- `sheet sheets <directory>` — list the sheets of a workbook, one
  line per sheet with its row count.

### Workbooks (multi-sheet)

A directory of CSVs is one workbook — one sheet per file, named
after the file (`examples/` is a workbook with sheets `employees`,
`monthly-sales` and `sales`). Every command accepts a directory where it accepts a
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
(e.g. `"total revenue by region"`). Time-grouped answers chart as a
line chart instead (e.g. `"total revenue by month"`), so the shape
over time is visible at a glance, and so do trend answers (e.g.
`"revenue trend by month"` — periods with no usable value are left
out of the line, never plotted as zero). A scalar or row answer prints the
answer with a note that there is nothing to chart, and an abstention
prints the abstention: the chart never invents a picture for an
answer that has none. Bars are proportional to the largest value and
every value is printed next to its bar, so a zero group is visible
as an empty bar with its `0`.

```bash
node dist/cli.js chart examples/sales.csv "total revenue by region"
node dist/cli.js chart examples/monthly-sales.csv "total revenue by month"
node dist/cli.js chart examples/sales.csv "total revenue by region" --svg revenue-by-region.svg
```

`--svg <path>` also writes the chart as a standalone SVG document
(group names are XML-escaped). `describe` prints a one-line
distribution sparkline under each numeric column, so skew and
clustering are visible at a glance. The chart helpers
(`renderBarChart`, `renderLineChart`, `histogram`, `sparkline`,
`renderBarChartSvg`, `renderLineChartSvg`)
are exported from the package for programmatic use.

### Explaining a question

When an answer looks wrong, `sheet explain` shows how the question
was understood — which operation, which column, which group-by and
time bucket, which filters, and how many rows a top-N ranks — without
running the query:

```bash
node dist/cli.js explain examples/sales.csv "total revenue by region"
```

```
Question: "total revenue by region"
Understood as: total of revenue, grouped by region
  operation: sum
  column: revenue
  group by: region
  filters: none
```

A question the parser cannot understand explains why, with the
columns available so it can be rephrased. With `--json` the output is
`{ question, sheet, ok, query }` or `{ question, sheet, ok, reason }`.
`explain` is workbook-aware like `ask` (`--sheet` or an
`in|from|on <sheet>` clause).

### Exporting results

`sheet ask --out <path>` writes the answer to a file as well as
printing it: `.json` writes the same `{ question, answer, result }`
object `--json` prints; `.csv` writes the result as a table — groups
as one column per group-by column plus `<column>,rows`
(`region,product,revenue,rows`), row results with their headers, a
scalar as one `label,value,rows_matched,values_used` row (a null value
stays blank, never `0`), a comparison as one row per period plus
`change` and `percent_change` rows. An abstention exports as a single
`question,answer` row, so the file still records what happened.

```bash
node dist/cli.js ask examples/sales.csv "total revenue by region" --out revenue-by-region.csv
node dist/cli.js ask examples/sales.csv "total revenue" --json --out total-revenue.json
```

## Data quality

`sheet profile <file>` (or `profileSheet(parsed)` in code) reports
what is wrong — or suspicious — about a sheet before anyone trusts
an answer computed from it:

```bash
node dist/cli.js profile messy.csv
```

```
9 rows, 3 columns

Warnings:
  - 1 duplicate row
  - "region" has a single distinct value
  - "score" has 1 outlier outside [5.75, 19.75]

id (integer)
  nulls: 0 (0%), distinct: 8
...
score (integer)
  nulls: 0 (0%), distinct: 7
  outliers: 1 outside [5.75, 19.75] (seen 1000 to 1000)
```

What it checks: duplicate rows (counted after the first occurrence),
fully-empty rows, per-column null rates (a column ≥50% null is
flagged), constant columns, non-null cells with leading/trailing
whitespace (a silent join breaker: `"Paris"` and `"Paris "` look
identical but are not), and numeric outliers by the Tukey IQR fence
(1.5 × IQR outside Q1/Q3, quartiles by the median-of-halves method;
fewer than 4 values means no fence). A clean sheet says so plainly —
`No quality issues found.` — instead of printing an empty report.
Like every other command it works on workbooks too (`--sheet <name>`
picks the sheet) and accepts `--json`.

## Evaluation

`npm run eval` scores the engine against a 109-question gold set over
the bundled samples (`src/eval.ts`, `GOLD_SET`): totals, averages,
medians, group-bys, multi-column group-bys (region × product,
department × remote) and top-N over them, top-N, bottom-N (lowest
products, regions, months and region × product pairs, headed
"Bottom N of M"), filters and row
queries, sorted row listings (revenue descending/ascending, region
alphabetical — order asserted by substrings spanning adjacent table
rows), above/below-average questions (revenue above/below its 223.7
average, salary above its 93,000 median and below its 93,000
average), missing-values questions (units 1 of 8, salary 1 of 5,
the whole-sheet report, the row listing, the Engineering-filtered
count), time grouping
(monthly totals, averages, counts, top months), correlation (units vs
revenue, id vs salary), period comparison (monthly revenue Jan→Feb
and Feb→Mar, average salary 2023→2024), share, distinct-values,
mode and distinct-count questions, percentile questions (p90/p50/p25
salary, p75/p90 revenue) and `between` range filters, trend
questions (monthly revenue +84.95/month, average revenue
+21.24/month, units +3.5/month, average salary −5,000/year), plus thirty-three questions the
honest answer is an abstention for (unknown column, unanswerable
question, unsupported period, correlation with a text column, a
comparison naming one period or the same period twice, a time bucket
combined with a second group column, a group word that is not a
column, a top-N over two groups plus a time bucket, a bottom-N over
a group plus a time bucket, a mode or
distinct count naming no column, a percentile outside 1–99, over a
text column or grouped by another column, a reversed `between`
range, a trend with no period, over a text column, plus a second
group column, or by an unsupported period, a sort on an unknown
column, or a sort phrase on an aggregate, an above/below-average
question naming an unknown or non-numeric column, a missing-values
question naming no column, grouped by another column, or listing
rows with no column named). Expected
values are hand-computed from the CSVs, never derived from the code
under test.

Baseline (2026-11-20): answer accuracy 76/76 (100%), abstention
accuracy 33/33 (100%), overall 100%. The run exits non-zero below an
80% overall-accuracy gate, and CI runs it after the test suite — so a
parser or engine change that breaks a question that used to work
fails the build. The eval caught a real bug on its first run: row
answers printed raw cell text (`98000`) while scalar answers format
numbers (`98,000`); `composeAnswer` now formats numeric columns in
row tables too (see `tests/answer.test.ts`).

## License

MIT
