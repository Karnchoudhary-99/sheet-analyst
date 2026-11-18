import { describe, expect, it } from "vitest";
import {
  askWorkbook,
  getSheet,
  listSheets,
  loadWorkbookFromDir,
  loadWorkbookFromFiles,
  sheetNameFromPath,
  WorkbookError,
  type Workbook,
} from "../src/workbook.js";

const SALES = "examples/sales.csv";
const EMPLOYEES = "examples/employees.csv";

function twoSheetWorkbook(): Workbook {
  return loadWorkbookFromFiles([SALES, EMPLOYEES]);
}

describe("sheetNameFromPath", () => {
  it("strips the directory and the .csv extension", () => {
    expect(sheetNameFromPath("data/quarterly-sales.csv")).toBe("quarterly-sales");
    expect(sheetNameFromPath("notes")).toBe("notes");
  });
});

describe("loadWorkbookFromFiles", () => {
  it("loads each file as a sheet named after the file", () => {
    const wb = twoSheetWorkbook();
    expect(listSheets(wb)).toEqual(["sales", "employees"]);
    expect(getSheet(wb, "sales")?.headers).toContain("revenue");
    expect(getSheet(wb, "employees")?.headers).toContain("salary");
  });

  it("disambiguates duplicate sheet names with a _2 suffix", () => {
    const wb = loadWorkbookFromFiles([SALES, "examples/sales.csv"]);
    expect(listSheets(wb)).toEqual(["sales", "sales_2"]);
  });

  it("throws a WorkbookError naming the missing file", () => {
    expect(() => loadWorkbookFromFiles(["nope.csv"])).toThrow(WorkbookError);
    expect(() => loadWorkbookFromFiles(["nope.csv"])).toThrow("nope.csv");
  });

  it("throws on an empty file list", () => {
    expect(() => loadWorkbookFromFiles([])).toThrow("No files given");
  });
});

describe("loadWorkbookFromDir", () => {
  it("loads every .csv in the directory, sorted", () => {
    const wb = loadWorkbookFromDir("examples");
    expect(listSheets(wb)).toEqual(["employees", "sales"]);
  });

  it("errors on a directory with no CSV files", () => {
    expect(() => loadWorkbookFromDir("src")).toThrow("No CSV files found");
  });

  it("errors on a path that is not a directory", () => {
    expect(() => loadWorkbookFromDir(SALES)).toThrow("not a directory");
  });
});

describe("getSheet", () => {
  it("matches sheet names case-insensitively", () => {
    const wb = twoSheetWorkbook();
    expect(getSheet(wb, "SALES")?.headers).toContain("revenue");
    expect(getSheet(wb, "Employees")?.headers).toContain("salary");
  });

  it("returns undefined for an unknown sheet", () => {
    expect(getSheet(twoSheetWorkbook(), "budgets")).toBeUndefined();
  });
});
