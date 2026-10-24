import { describe, expect, it } from "vitest";
import { readingOrder, type ReadingOrderArtboard } from "@redline/shared";

const board = (file: string, x: number, y: number, width = 200, height = 100): ReadingOrderArtboard => ({ file, x, y, width, height });
const files = (list: { file: string }[]) => list.map((a) => a.file);

describe("readingOrder", () => {
  it("numbers rows top to bottom and artboards left to right, whatever the manifest order", () => {
    const result = readingOrder([board("d", 300, 400), board("b", 300, 0), board("c", 0, 400), board("a", 0, 0)], []);
    expect(result.map((a) => [a.file, a.number])).toEqual([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
  });

  it("puts artboards of different heights, slightly offset, in the same row", () => {
    const result = readingOrder([board("right", 600, 40, 200, 300), board("left", 0, 0, 200, 100), board("mid", 300, 90, 200, 50), board("below", 0, 500)], []);
    expect(files(result)).toEqual(["left", "mid", "right", "below"]);
  });

  it("does not merge artboards that only touch vertically", () => {
    const result = readingOrder([board("low-left", 0, 100), board("high-right", 400, 0)], []);
    expect(files(result)).toEqual(["high-right", "low-left"]);
  });

  it("assigns each artboard to the nearest title above its row that covers it horizontally", () => {
    const titles = [
      { text: "Onboarding", x: 0, y: -80, width: 500 },
      { text: "Paiement", x: 0, y: 300, width: 500 },
      { text: "Compte", x: 700, y: -80, width: 400 },
    ];
    const result = readingOrder([board("a", 0, 0), board("b", 250, 0), board("c", 0, 400), board("d", 800, 0)], titles);
    expect(result.map((a) => [a.file, a.groupTitle])).toEqual([
      ["a", "Onboarding"],
      ["b", "Onboarding"],
      ["d", "Compte"],
      ["c", "Paiement"],
    ]);
  });

  it("leaves artboards outside any title in an untitled group, listed in reading order", () => {
    const result = readingOrder([board("lonely", 2000, 0), board("a", 0, 0)], [{ text: "Flow", x: 0, y: -80, width: 500 }]);
    expect(result.map((a) => [a.file, a.number, a.groupTitle])).toEqual([["a", 1, "Flow"], ["lonely", 2, null]]);
  });

  it("ignores a title below the row", () => {
    expect(readingOrder([board("a", 0, 0)], [{ text: "Later", x: 0, y: 500, width: 500 }])[0]!.groupTitle).toBeNull();
  });

  it("lists a responsive artboard once, with its laid-out size", () => {
    const result = readingOrder([{ ...board("home.html", 0, 0, 1500, 800), title: "Home" }, board("next", 1600, 100)], []);
    expect(result.map((a) => [a.file, a.number, a.title])).toEqual([["home.html", 1, "Home"], ["next", 2, undefined]]);
  });
});
