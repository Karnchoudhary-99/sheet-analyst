import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import { inferColumnType, inferSchema } from "../src/schema.js";

describe("inferColumnType", () => {
  it("detects integers and floats", () => {
    expect(inferColumnType(["1", "2", "3"])).toBe("integer");
    expect(inferColumnType(["1.5", "2", "3.25"])).toBe("number");
    expect(inferColumnType(["1,234", "5,678"])).toBe("integer");
  });

  it("detects booleans before numbers", () => {
    expect(inferColumnType(["true", "false", "TRUE"])).toBe("boolean");
    expect(inferColumnType(["yes", "no", "Yes"])).toBe("boolean");
  });

  it("detects ISO and day-first dates", () => {
    expect(inferColumnType(["2026-01-05", "2026-11-18"])).toBe("date");
    expect(inferColumnType(["05/01/2026", "18/11/2026"])).toBe("date");
    expect(inferColumnType(["2026-01-05T10:30:00Z"])).toBe("date");
  });

  it("falls back to text on mixed content", () => {
    expect(inferColumnType(["12", "twelve"])).toBe("text");
    expect(inferColumnType(["Paris", "Lyon"])).toBe("text");
  });

  it("ignores null markers when deciding", () => {
    expect(inferColumnType(["1", "", "NA", "3"])).toBe("integer");
    expect(inferColumnType(["", "null", "-"])).toBe("empty");
  });
});

describe("inferSchema", () => {
  it("infers a whole document", () => {
    const parsed = parseCsv(
      "id,name,score,active,joined\n1,Ada,9.5,true,2026-01-05\n2,Grace,,false,2026-02-01",
    );
    const schema = inferSchema(parsed);
    expect(schema.map((c) => [c.name, c.type])).toEqual([
      ["id", "integer"],
      ["name", "text"],
      ["score", "number"],
      ["active", "boolean"],
      ["joined", "date"],
    ]);
    const score = schema.find((c) => c.name === "score")!;
    expect(score.nullCount).toBe(1);
    expect(score.distinctCount).toBe(1);
    expect(score.sample).toEqual(["9.5"]);
  });
});
