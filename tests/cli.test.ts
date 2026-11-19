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

describe("runCli workbooks", () => {
  const examplesDir = join(root, "examples");

  it("lists sheets with row counts", async () => {
    const c = capture();
    expect(await runCli(["sheets", examplesDir], c.out)).toBe(0);
    expect(c.stdout.join("")).toContain("employees (");
    expect(c.stdout.join("")).toContain("sales (8 rows)");
  });

  it("asks a workbook by naming the sheet in the question", async () => {
    const c = capture();
    expect(
      await runCli(["ask", examplesDir, "total revenue in sales"], c.out),
    ).toBe(0);
    expect(c.stdout.join("")).toContain("1,789.6");
  });

  it("asks a workbook with --sheet and reports the sheet in JSON", async () => {
    const c = capture();
    expect(
      await runCli(
        ["ask", examplesDir, "average salary", "--sheet", "employees", "--json"],
        c.out,
      ),
    ).toBe(0);
    const out = JSON.parse(c.stdout.join(""));
    expect(out.sheet).toBe("employees");
    expect(out.result.kind).toBe("scalar");
  });

  it("abstains with the sheet list when the workbook question names no sheet", async () => {
    const c = capture();
    expect(await runCli(["ask", examplesDir, "total revenue"], c.out)).toBe(0);
    expect(c.stdout.join("")).toContain("Sheets available: employees, monthly-sales, sales");
  });

  it("runs columns/describe on a workbook sheet with --sheet", async () => {
    const c = capture();
    expect(
      await runCli(["columns", examplesDir, "--sheet", "sales"], c.out),
    ).toBe(0);
    expect(c.stdout.join("")).toContain("revenue");

    const d = capture();
    expect(
      await runCli(["describe", examplesDir, "--sheet", "employees"], d.out),
    ).toBe(0);
    expect(d.stdout.join("")).toContain("salary (integer)");
  });

  it("requires --sheet for columns on a multi-sheet workbook", async () => {
    const c = capture();
    expect(await runCli(["columns", examplesDir], c.out)).toBe(2);
    expect(c.stderr.join("")).toContain("Multiple sheets");
  });

  it("reports an unknown sheet with exit 2", async () => {
    const c = capture();
    expect(
      await runCli(["columns", examplesDir, "--sheet", "budgets"], c.out),
    ).toBe(2);
    expect(c.stderr.join("")).toContain('No sheet named "budgets"');
  });

  it("rejects --sheet without a value", () => {
    expect(() => parseArgs(["ask", "x.csv", "total revenue", "--sheet"])).toThrowError(
      /--sheet needs a sheet name/,
    );
  });
});

describe("runCli charts", () => {
  const examplesDir = join(root, "examples");

  it("charts a group-by answer with bars and values", async () => {
    const c = capture();
    expect(
      await runCli(["chart", salesPath, "total revenue by region"], c.out),
    ).toBe(0);
    const text = c.stdout.join("");
    expect(text).toContain("Total revenue by region");
    expect(text).toContain("North");
    expect(text).toContain("█");
  });

  it("charts a time-grouped answer with a line chart, not bars", async () => {
    const monthlyPath = join(root, "examples", "monthly-sales.csv");
    const c = capture();
    expect(
      await runCli(["chart", monthlyPath, "total revenue by month"], c.out),
    ).toBe(0);
    const text = c.stdout.join("");
    expect(text).toContain("Total revenue by month");
    expect(text).toContain("Jan 2026");
    expect(text).toContain("●");
    expect(text).not.toContain("█");
  });

  it("says so instead of charting a scalar answer", async () => {
    const c = capture();
    expect(await runCli(["chart", salesPath, "total revenue"], c.out)).toBe(0);
    const text = c.stdout.join("");
    expect(text).toContain("1,789.6");
    expect(text).toContain("No chart for this answer");
    expect(text).not.toContain("█");
  });

  it("charts an abstention honestly with exit 0", async () => {
    const c = capture();
    expect(await runCli(["chart", salesPath, "total profit"], c.out)).toBe(0);
    expect(c.stdout.join("")).toContain("I can't answer that");
  });

  it("writes an SVG file with --svg", async () => {
    const { readFileSync, unlinkSync } = await import("node:fs");
    const tmp = join(root, "examples", ".cli-chart.svg");
    const c = capture();
    try {
      expect(
        await runCli(
          ["chart", salesPath, "total revenue by region", "--svg", tmp],
          c.out,
        ),
      ).toBe(0);
      expect(c.stdout.join("")).toContain(`Wrote ${tmp}`);
      const svg = readFileSync(tmp, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("North");
    } finally {
      unlinkSync(tmp);
    }
  });

  it("rejects --svg on other commands and without a value", () => {
    expect(() =>
      parseArgs(["ask", "x.csv", "total revenue", "--svg", "out.svg"]),
    ).toThrowError(/--svg is only for the chart command/);
    expect(() => parseArgs(["chart", "x.csv", "total revenue", "--svg"])).toThrowError(
      /--svg needs a file path/,
    );
  });

  it("charts a workbook sheet named in the question", async () => {
    const c = capture();
    expect(
      await runCli(["chart", examplesDir, "total revenue by region in sales"], c.out),
    ).toBe(0);
    expect(c.stdout.join("")).toContain("North");
    expect(c.stdout.join("")).toContain("█");
  });

  it("describe shows a distribution sparkline for numeric columns", async () => {
    const c = capture();
    expect(await runCli(["describe", salesPath], c.out)).toBe(0);
    expect(c.stdout.join("")).toContain("distribution:");
  });
});

describe("runCli profile", () => {
  const examplesDir = join(root, "examples");

  it("parses the profile command and its help", () => {
    expect(parseArgs(["profile", "x.csv"])).toEqual({
      command: "profile",
      file: "x.csv",
      sheet: undefined,
      svg: undefined,
      json: false,
    });
    expect(parseArgs(["profile", "--help"])).toEqual({
      command: "help",
      helpFor: "profile",
      json: false,
    });
  });

  it("profiles a clean sheet in text and JSON", async () => {
    const text = capture();
    expect(await runCli(["profile", salesPath], text.out)).toBe(0);
    const out = text.stdout.join("");
    expect(out).toContain("8 rows, 5 columns");
    expect(out).toContain("revenue (number)");

    const json = capture();
    expect(await runCli(["profile", "--json", salesPath], json.out)).toBe(0);
    const profile = JSON.parse(json.stdout.join(""));
    expect(profile.rows).toBe(8);
    expect(profile.columnCount).toBe(5);
    expect(Array.isArray(profile.warnings)).toBe(true);
    expect(profile.columns.map((c: { name: string }) => c.name)).toEqual([
      "date",
      "region",
      "product",
      "units",
      "revenue",
    ]);
  });

  it("flags duplicates and outliers in a messy sheet", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmp = join(root, "examples", ".cli-messy.csv");
    const messy = [
      "id,region,score",
      "1,North,10",
      "2,North,11",
      "3,North,12",
      "4,North,12",
      "5,North,13",
      "6,North,14",
      "7,North,15",
      "8,North,1000",
      "2,North,11",
    ].join("\n");
    writeFileSync(tmp, messy + "\n");
    try {
      const text = capture();
      expect(await runCli(["profile", tmp], text.out)).toBe(0);
      const out = text.stdout.join("");
      expect(out).toContain("1 duplicate row");
      expect(out).toContain('"score" has 1 outlier');

      const json = capture();
      expect(await runCli(["profile", "--json", tmp], json.out)).toBe(0);
      const profile = JSON.parse(json.stdout.join(""));
      expect(profile.duplicateRows).toBe(1);
      expect(profile.warnings).toContain("1 duplicate row");
      expect(
        profile.columns.find((c: { name: string }) => c.name === "score")
          .outliers.count,
      ).toBe(1);
    } finally {
      unlinkSync(tmp);
    }
  });

  it("profiles a workbook sheet with --sheet, and requires one", async () => {
    const c = capture();
    expect(
      await runCli(["profile", examplesDir, "--sheet", "sales"], c.out),
    ).toBe(0);
    expect(c.stdout.join("")).toContain("revenue (number)");

    const missing = capture();
    expect(await runCli(["profile", examplesDir], missing.out)).toBe(2);
    expect(missing.stderr.join("")).toContain("Multiple sheets");
  });
});
