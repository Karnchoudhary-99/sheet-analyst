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

describe("askWorkbook", () => {
  it("answers from the sheet named in a trailing 'in <sheet>' clause", () => {
    const { sheet, answer } = askWorkbook("total revenue in sales", twoSheetWorkbook());
    expect(sheet).toBe("sales");
    expect(answer).toContain("1,789.6");
  });

  it("strips the sheet clause so it is not read as a filter", () => {
    // "sales" is not a region value; without stripping, the question
    // would still parse — but the answer must come from sales.csv.
    const { sheet, answer } = askWorkbook("average salary in employees", twoSheetWorkbook());
    expect(sheet).toBe("employees");
    expect(answer).toContain("salary");
  });

  it("uses the preferred sheet and ignores the question's sheet clause", () => {
    const { sheet } = askWorkbook(
      "total revenue in sales",
      twoSheetWorkbook(),
      "employees",
    );
    expect(sheet).toBe("employees");
  });

  it("abstains naming the sheets when no sheet is given", () => {
    const { sheet, answer } = askWorkbook("total revenue", twoSheetWorkbook());
    expect(sheet).toBeNull();
    expect(answer).toContain("Sheets available: sales, employees");
  });

  it("abstains when the preferred sheet does not exist", () => {
    const { sheet, answer } = askWorkbook("total revenue", twoSheetWorkbook(), "budgets");
    expect(sheet).toBeNull();
    expect(answer).toContain('no sheet named "budgets"');
    expect(answer).toContain("Sheets available: sales, employees");
  });

  it("answers from the only sheet without being asked", () => {
    const wb = loadWorkbookFromFiles([SALES]);
    const { sheet, answer } = askWorkbook("total revenue", wb);
    expect(sheet).toBe("sales");
    expect(answer).toContain("1,789.6");
  });

  it("abstains on an empty workbook", () => {
    const { sheet, answer } = askWorkbook("total revenue", { sheets: new Map() });
    expect(sheet).toBeNull();
    expect(answer).toContain("no sheets");
  });
});
  it("matches sheet names case-insensitively", () => {
    const wb = twoSheetWorkbook();
    expect(getSheet(wb, "SALES")?.headers).toContain("revenue");
    expect(getSheet(wb, "Employees")?.headers).toContain("salary");
  });

  it("returns undefined for an unknown sheet", () => {
    expect(getSheet(twoSheetWorkbook(), "budgets")).toBeUndefined();
  });
});
