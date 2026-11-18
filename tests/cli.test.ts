/**
 * Tests for the `sheet` CLI: argument parsing, formatters, the ask
 * JSON shape, and end-to-end runs with captured output (no process
 * spawning — `runCli` takes an output sink).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import {
  askJson,
  CliError,
  describeWithTypes,
  formatColumnsText,
  formatDescribeText,
  parseArgs,
  runCli,
  type CliOutput,
} from "../src/cli.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const salesPath = join(root, "examples", "sales.csv");
const staffPath = join(root, "examples", "employees.csv");
const sales = parseCsv(readFileSync(salesPath, "utf8"));
const staff = parseCsv(readFileSync(staffPath, "utf8"));

function capture(): { out: CliOutput; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    out: {
      stdout: (t) => stdout.push(t),
      stderr: (t) => stderr.push(t),
    },
    stdout,
    stderr,
  };
}

describe("parseArgs", () => {
  it("rejects no arguments with exit code 2", () => {
    expect(() => parseArgs([])).toThrowError(CliError);
    try {
      parseArgs([]);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it("rejects unknown commands", () => {
    expect(() => parseArgs(["frobnicate", "x.csv"])).toThrowError(
      /Unknown command/,
    );
  });

  it("parses --help and --version", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help", json: false });
    expect(parseArgs(["-h"])).toEqual({ command: "help", json: false });
    expect(parseArgs(["--version"])).toEqual({
      command: "version",
      json: false,
    });
  });

  it("parses per-command help", () => {
    expect(parseArgs(["ask", "--help"])).toEqual({
      command: "help",
      helpFor: "ask",
      json: false,
    });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["columns", "x.csv", "--yaml"])).toThrowError(
      /Unknown flag/,
    );
  });

  it("requires a file for every command", () => {
    expect(() => parseArgs(["describe"])).toThrowError(/Missing file/);
  });

  it("requires a question for ask", () => {
    expect(() => parseArgs(["ask", "x.csv"])).toThrowError(
      /Missing question/,
    );
  });

  it("rejects extra positionals for columns/describe", () => {
    expect(() => parseArgs(["columns", "x.csv", "extra"])).toThrowError(
      /Unexpected argument/,
    );
  });

  it("joins ask question words and accepts --json anywhere", () => {
    expect(parseArgs(["ask", "x.csv", "total", "revenue"])).toEqual({
      command: "ask",
      file: "x.csv",
      question: "total revenue",
      json: false,
    });
    expect(parseArgs(["columns", "--json", "x.csv"])).toEqual({
      command: "columns",
      file: "x.csv",
      json: true,
    });
    expect(parseArgs(["ask", "x.csv", "--json", "total revenue"])).toEqual({
      command: "ask",
      file: "x.csv",
      question: "total revenue",
      json: true,
    });
  });
});

describe("formatColumnsText", () => {
  it("lists columns with types, nulls and samples", () => {
    const text = formatColumnsText(sales);
    expect(text).toContain("8 rows, 5 columns");
    expect(text).toMatch(/revenue\s+number/);
    expect(text).toMatch(/date\s+date/);
    expect(text).toMatch(/region\s+text/);
    expect(text).toContain("Widget A");
  });
});

describe("formatDescribeText", () => {
  it("summarizes numeric columns", () => {
    const text = formatDescribeText(sales);
    expect(text).toContain("revenue (number)");
    expect(text).toContain("min:");
    expect(text).toContain("mean:");
    expect(text).toContain("stddev:");
  });

  it("shows a date range instead of epoch statistics", () => {
    const text = formatDescribeText(sales);
    expect(text).toContain("date (date)");
    expect(text).toMatch(/range: 2026-01-05 to 2026-/);
    expect(text).toContain("median:");
    // The date block must not leak raw epoch numbers.
    const dateBlock = text.split("date (date)")[1].split("\n\n")[0];
    expect(dateBlock).not.toMatch(/\d{13}/);
  });

  it("lists top values for categorical columns", () => {
    const text = formatDescribeText(staff);
    expect(text).toContain("department (text)");
    expect(text).toContain("Engineering");
  });
});

describe("describeWithTypes", () => {
  it("pairs each description with its inferred type", () => {
    const described = describeWithTypes(sales);
    expect(described.find((d) => d.name === "date")?.type).toBe("date");
    expect(described.find((d) => d.name === "revenue")?.type).toBe("number");
    expect(described.find((d) => d.name === "revenue")?.stats.kind).toBe(
      "numeric",
    );
  });
});

describe("askJson", () => {
  it("returns the answer plus the structured result", () => {
    const out = askJson("total revenue", sales);
    expect(out.question).toBe("total revenue");
    expect(out.result?.kind).toBe("scalar");
    if (out.result?.kind === "scalar") {
      expect(out.result.value).toBeCloseTo(1789.6, 6);
    }
    expect(out.answer).toContain("1,789.6");
  });

  it("returns a null result on abstention", () => {
    const out = askJson("total profit", sales);
    expect(out.result).toBeNull();
    expect(out.answer).toContain("I can't answer that");
  });
});

describe("runCli end-to-end", () => {
  it("prints help and version", async () => {
    const help = capture();
    expect(await runCli(["--help"], help.out)).toBe(0);
    expect(help.stdout.join("")).toContain("Usage:");

    const version = capture();
    expect(await runCli(["--version"], version.out)).toBe(0);
    expect(version.stdout.join("")).toMatch(/^sheet 0\.1\.0/);

    const cmdHelp = capture();
    expect(await runCli(["ask", "--help"], cmdHelp.out)).toBe(0);
    expect(cmdHelp.stdout.join("")).toContain("sheet ask");
  });

  it("runs columns in text and JSON", async () => {
    const text = capture();
    expect(await runCli(["columns", salesPath], text.out)).toBe(0);
    expect(text.stdout.join("")).toContain("revenue");

    const json = capture();
    expect(await runCli(["columns", "--json", salesPath], json.out)).toBe(0);
    const schema = JSON.parse(json.stdout.join(""));
    expect(schema.map((c: { name: string }) => c.name)).toEqual([
      "date",
      "region",
      "product",
      "units",
      "revenue",
    ]);
  });

  it("runs describe in text and JSON", async () => {
    const text = capture();
    expect(await runCli(["describe", staffPath], text.out)).toBe(0);
    expect(text.stdout.join("")).toContain("salary (integer)");

    const json = capture();
    expect(await runCli(["describe", "--json", staffPath], json.out)).toBe(0);
    const described = JSON.parse(json.stdout.join(""));
    expect(described.find((d: { name: string }) => d.name === "salary").type)
      .toBe("integer");
  });

  it("runs ask in text and JSON", async () => {
    const text = capture();
    expect(await runCli(["ask", salesPath, "total revenue"], text.out)).toBe(
      0,
    );
    expect(text.stdout.join("")).toContain("1,789.6");

    const json = capture();
    expect(
      await runCli(["ask", salesPath, "top 3 products by revenue", "--json"], json.out),
    ).toBe(0);
    const out = JSON.parse(json.stdout.join(""));
    expect(out.question).toBe("top 3 products by revenue");
    expect(out.result.kind).toBe("groups");
    expect(out.result.groups[0].key).toBe("Widget A");
  });

  it("answers an abstention honestly with exit 0", async () => {
    const c = capture();
    expect(await runCli(["ask", salesPath, "total profit"], c.out)).toBe(0);
    expect(c.stdout.join("")).toContain("I can't answer that");
  });

  it("reports a missing file with exit 1", async () => {
    const c = capture();
    expect(
      await runCli(["columns", join(root, "examples", "nope.csv")], c.out),
    ).toBe(1);
    expect(c.stderr.join("")).toMatch(/Cannot read file/);
    expect(c.stdout.join("")).toBe("");
  });

  it("reports usage errors with exit 2", async () => {
    const c = capture();
    expect(await runCli(["frobnicate", "x.csv"], c.out)).toBe(2);
    expect(c.stderr.join("")).toContain("Unknown command");
  });

  it("reports a malformed CSV with exit 1", async () => {
    const c = capture();
    // Build the bad file through the CLI path instead: use a real
    // malformed string written via the loader's parse step.
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmp = join(root, "examples", ".cli-bad.csv");
    writeFileSync(tmp, 'a,b\n"unterminated,x\n');
    try {
      expect(await runCli(["columns", tmp], c.out)).toBe(1);
      expect(c.stderr.join("")).toMatch(/Cannot parse/);
    } finally {
      unlinkSync(tmp);
    }
  });
});
