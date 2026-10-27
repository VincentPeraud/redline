import { describe, expect, it } from "vitest";
import { columnShifts } from "../src/columnShift.js";

const item = (id: string, x: number, y: number, width: number, height: number, shownHeight = height) => ({ id, box: { x, y, width, height }, shownHeight });

describe("column shifts", () => {
  it("pushes down what sits under an artboard that grows, by its growth", () => {
    const shifts = columnShifts([item("sorties", 4800, 0, 1900, 960, 1700), item("planifier", 4800, 1800, 1900, 960)]);
    expect(shifts.get("sorties")).toBe(0);
    expect(shifts.get("planifier")).toBe(740);
  });

  it("leaves another column where it is", () => {
    const shifts = columnShifts([item("vols", 0, 0, 1440, 900), item("sorties", 4800, 0, 1900, 960, 1700), item("rattacher", 0, 1800, 1440, 900)]);
    expect(shifts.get("rattacher")).toBe(0);
  });

  it("carries a shift down the column and takes the largest push from above", () => {
    const shifts = columnShifts([
      item("a", 0, 0, 1000, 500, 800),
      item("b", 600, 0, 1000, 500, 600),
      item("c", 0, 700, 1600, 500, 900),
      item("d", 0, 1400, 500, 500),
    ]);
    expect(shifts.get("c")).toBe(300);
    expect(shifts.get("d")).toBe(700);
  });

  it("pulls up what is under an artboard shorter than declared, keeping the gap", () => {
    const shifts = columnShifts([item("a", 0, 0, 1000, 900, 600), item("b", 0, 1000, 1000, 500)]);
    expect(shifts.get("b")).toBe(-300);
  });

  it("ignores what sits beside, not under", () => {
    const shifts = columnShifts([item("a", 0, 0, 1000, 900, 1500), item("note", 1100, 200, 300, 100)]);
    expect(shifts.get("note")).toBe(0);
  });

  it("moves a point at the artboard's left edge, and never chains items starting at the same y", () => {
    const shifts = columnShifts([item("a", 0, 0, 1000, 900, 1500), item("end", 0, 1000, 0, 0), item("title", 0, 1000, 0, 0), item("b", 0, 1000, 1000, 500)]);
    expect(shifts.get("end")).toBe(600);
    expect(shifts.get("b")).toBe(600);
  });
});
