import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import { iqrOutliers, profileColumn, profileSheet } from "../src/profile.js";

const MESSY = `id,name,region,score,note
1,Alice,Paris,10,ok
2,Bob,Paris,11,ok
3,Carol,Paris,12,ok
4,Dave,Paris,12,ok
5,Eve,Paris,13,ok
6,Frank,Paris,14,ok
7,Grace, Lyon ,15,ok
8,Heidi,Paris,1000,ok
2,Bob,Paris,11,ok
,,
9,Ivan,Paris,,ok
`;

describe("iqrOutliers", () => {
  it("finds a single far value outside the Tukey fence", () => {
    const out = iqrOutliers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000]);
    expect(out).not.toBeNull();
    expect(out!.count).toBe(1);
    expect(out!.low).toBe(1000);
    expect(out!.high).toBe(1000);
    // Q1 = 3, Q3 = 9, IQR = 6, fence [-6, 18].
    expect(out!.lowBound).toBe(-6);
    expect(out!.highBound).toBe(18);
  });

  it("returns null when nothing is outside the fence", () => {
    expect(iqrOutliers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeNull();
  });

  it("returns null below 4 values — a fence needs quartiles", () => {
    expect(iqrOutliers([1, 2, 1000])).toBeNull();
  });

  it("a zero IQR still flags values different from the middle half", () => {
    const out = iqrOutliers([5, 5, 5, 5, 5, 5, 5, 9]);
    expect(out).not.toBeNull();
    expect(out!.count).toBe(1);
    expect(out!.high).toBe(9);
  });
});

describe("profileSheet", () => {
  const profile = profileSheet(parseCsv(MESSY));

  it("counts rows, columns, duplicates and empty rows", () => {
    expect(profile.rows).toBe(11);
    expect(profile.columnCount).toBe(5);
    expect(profile.duplicateRows).toBe(1);
    expect(profile.emptyRows).toBe(1);
  });

  it("reports per-column null rates", () => {
    const id = profile.columns.find((c) => c.name === "id")!;
    expect(id.nullCount).toBe(1);
    expect(id.nullRate).toBeCloseTo(1 / 11);
    const score = profile.columns.find((c) => c.name === "score")!;
    expect(score.nullCount).toBe(2);
  });

  it("flags the constant column and the whitespace cell", () => {
    const note = profile.columns.find((c) => c.name === "note")!;
    expect(note.constant).toBe(true);
    expect(note.distinctCount).toBe(1);
    const region = profile.columns.find((c) => c.name === "region")!;
    // " Lyon " keeps its spaces: the parser does not trim unquoted cells.
    expect(region.whitespaceCells).toBe(1);
  });

  it("flags the numeric outlier in score", () => {
    const score = profile.columns.find((c) => c.name === "score")!;
    expect(score.outliers).toBeDefined();
    expect(score.outliers!.count).toBe(1);
    expect(score.outliers!.high).toBe(1000);
  });

  it("does not attach outliers to text columns", () => {
    const name = profile.columns.find((c) => c.name === "name")!;
    expect(name.outliers).toBeUndefined();
  });

  it("lists warnings in sheet order then column order", () => {
    expect(profile.warnings).toContain("1 duplicate row");
    expect(profile.warnings).toContain("1 empty row");
    expect(profile.warnings).toContain('"note" has a single distinct value');
    expect(profile.warnings).toContain(
      '"region" has 1 cell with leading/trailing whitespace',
    );
    expect(profile.warnings.some((w) => w.startsWith('"score" has 1 outlier'))).toBe(true);
  });

  it("reports a clean sheet with no warnings", () => {
    const clean = profileSheet(
      parseCsv("a,b\n1,x\n2,y\n3,z\n4,w\n"),
    );
    expect(clean.warnings).toEqual([]);
    expect(clean.duplicateRows).toBe(0);
    expect(clean.emptyRows).toBe(0);
  });

  it("flags a column that is mostly null", () => {
    const mostlyNull = profileSheet(parseCsv("a,b\n1,\n2,\n3,\n4,x\n"));
    expect(mostlyNull.warnings).toContain('"b" is 75% null');
  });

  it("an all-null column is not called constant", () => {
    const allNull = profileSheet(parseCsv("a,b\n1,\n2,\n"));
    const b = allNull.columns.find((c) => c.name === "b")!;
    expect(b.type).toBe("empty");
    expect(b.constant).toBe(false);
    expect(b.distinctRate).toBe(0);
    expect(allNull.warnings).toContain('"b" is 100% null');
  });
});

describe("profileColumn", () => {
  it("distinct rate is distinct over present values", () => {
    const col = profileColumn(["a", "a", "b", ""], "x", "text");
    expect(col.distinctCount).toBe(2);
    expect(col.distinctRate).toBeCloseTo(2 / 3);
    expect(col.nullCount).toBe(1);
  });
});
