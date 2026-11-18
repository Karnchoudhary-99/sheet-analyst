/**
 * RFC 4180 CSV parsing: quoted fields (embedded commas, newlines and
 * escaped `""`), CRLF / LF / CR line endings, and a leading UTF-8 BOM.
 * No dependencies — the parser is a small character state machine so a
 * malformed file fails loudly instead of silently shifting columns.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Split raw CSV text into rows of raw field strings. */
export function parseRows(text: string): string[][] {
  const src = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true; // true while no characters of the field seen yet
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStart = true;
  };
  const endRow = () => {
    endField();
    // Skip blank lines: a row that is a single empty field.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    fieldStart = false;
    i += 1;
  }
  if (inQuotes) {
    throw new CsvParseError("unterminated quoted field");
  }
  // Flush the final field/row when the file does not end with a newline.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

/**
 * Parse a whole CSV document. The first non-blank row is the header;
 * duplicate or empty header names are disambiguated (`name`, `name_2`,
 * `column_3`). Short rows are padded with "" to the header width.
 */
export function parseCsv(text: string): ParsedCsv {
  const rows = parseRows(text);
  if (rows.length === 0) {
    throw new CsvParseError("empty CSV: no header row found");
  }
  const rawHeaders = rows[0];
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h, idx) => {
    const base = h.trim() === "" ? `column_${idx + 1}` : h.trim();
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
  const data = rows.slice(1).map((r) => {
    const padded = r.slice(0, headers.length);
    while (padded.length < headers.length) padded.push("");
    return padded;
  });
  return { headers, rows: data };
}

/** Turn a parsed document into one object per row, keyed by header. */
export function toRecords(parsed: ParsedCsv): Record<string, string>[] {
  return parsed.rows.map((r) => {
    const rec: Record<string, string> = {};
    parsed.headers.forEach((h, i) => {
      rec[h] = r[i] ?? "";
    });
    return rec;
  });
}
