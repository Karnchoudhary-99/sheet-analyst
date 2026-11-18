import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv, parseRows, toRecords } from "../src/csv.js";

describe("parseRows", () => {
  it("parses a plain document", () => {
    expect(parseRows("a,b,c\n1,2,3\n4,5,6")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles CRLF and lone CR endings", () => {
    expect(parseRows("a,b\r\n1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps commas and newlines inside quoted fields", () => {
    expect(parseRows('a,b\n"hello, world","line1\nline2"')).toEqual([
      ["a", "b"],
      ["hello, world", "line1\nline2"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseRows('a\n"say ""hi"" now"')).toEqual([["a"], ['say "hi" now']]);
  });

  it("keeps an empty field and a trailing comma", () => {
    expect(parseRows("a,b,c\n1,,3\n,2,")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["", "2", ""],
    ]);
  });

  it("skips blank lines", () => {
    expect(parseRows("a,b\n\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseRows("\ufeffa,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseRows('a,b\n"oops,2')).toThrow(CsvParseError);
  });

  it("treats a quote mid-field as a literal character", () => {
    expect(parseRows('a\nsay "hi"')).toEqual([["a"], ['say "hi"']]);
  });
});

describe("parseCsv", () => {
  it("disambiguates duplicate headers", () => {
    const parsed = parseCsv("name,name,age\nAda,Ada,36");
    expect(parsed.headers).toEqual(["name", "name_2", "age"]);
    expect(parsed.rows).toEqual([["Ada", "Ada", "36"]]);
  });

  it("names empty headers column_N", () => {
    const parsed = parseCsv(",b\n1,2");
    expect(parsed.headers).toEqual(["column_1", "b"]);
  });

  it("pads ragged rows with empty strings", () => {
    const parsed = parseCsv("a,b,c\n1,2\n3,4,5,6");
    expect(parsed.rows).toEqual([
      ["1", "2", ""],
      ["3", "4", "5"],
    ]);
  });

  it("rejects an empty document", () => {
    expect(() => parseCsv("")).toThrow(CsvParseError);
    expect(() => parseCsv("\n\n")).toThrow(CsvParseError);
  });

  it("toRecords keys rows by header", () => {
    const parsed = parseCsv("city,pop\nParis,2.1\nLyon,0.5");
    expect(toRecords(parsed)).toEqual([
      { city: "Paris", pop: "2.1" },
      { city: "Lyon", pop: "0.5" },
    ]);
  });
});
