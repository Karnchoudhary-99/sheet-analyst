# Spreadsheet Analyst

Chat with your CSVs — ask questions in plain English and get answers
computed from the data, with the numbers to back them up. No LLM key
needed for the local engine: an offline, deterministic query engine
answers descriptive questions (counts, sums, averages, filters, groups,
top-N) directly from the spreadsheet.

> **Status:** in progress (project #39 of the portfolio program).

## Roadmap

- [x] Project scaffold (README roadmap, license, gitignore, CI)
- [ ] CSV ingestion (RFC 4180 parser, quoted fields, ragged rows, encoding)
- [ ] Schema inference (number / date / boolean / text, nulls, samples)
- [ ] Descriptive statistics (count, mean, median, min/max, distinct)
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

## License

MIT
