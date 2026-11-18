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
- [ ] Natural-language query engine (filter, aggregate, group-by, top-N)
- [ ] Answer composer (cited numbers, honest "not in the data" handling)
- [ ] CLI (`sheet ask`, `sheet describe`, `sheet columns`)
- [ ] Eval harness (gold question set, accuracy + abstention metrics)
- [ ] Multi-sheet workbooks (XLSX via sheet names, CSV directory import)
- [ ] Charts (ASCII + SVG output for distributions and trends)
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

## License

MIT
