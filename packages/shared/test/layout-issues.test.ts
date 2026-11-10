import { expect, it } from "vitest";
import { estimatedNoteSize, pageLayoutIssues, parseManifest } from "@redline/shared";

const LONG = Array.from({ length: 6 }, () => "- A long line of decisions that wraps on two lines at least").join("\n");
const issues = (elements: object[], artboards: object[] = [{ file: "sortie.html", x: 0, y: 0, width: 1440, height: 900 }]) =>
  pageLayoutIssues(parseManifest(JSON.stringify({ artboards, elements })));

it("estimates a note's height from its width, size and text", () => {
  const short = estimatedNoteSize(parseManifest(JSON.stringify({ elements: [{ kind: "text", text: "Short", width: 420 }] })).elements[0] as never);
  const long = estimatedNoteSize(parseManifest(JSON.stringify({ elements: [{ kind: "text", text: LONG, width: 420 }] })).elements[0] as never);
  expect(short.width).toBe(420);
  expect(short.height).toBeGreaterThan(50);
  expect(short.height).toBeLessThan(90);
  expect(long.height).toBeGreaterThan(300);
});

it("reports a sticky placed by x and y over a long note, and suggests anchoring it", () => {
  expect(
    issues([
      { kind: "text", id: "note-decisions", text: LONG, width: 420, x: 1500, y: 0 },
      { kind: "sticky", id: "q-droits", text: "Who can edit?", x: 1500, y: 250 },
    ]),
  ).toEqual(['"q-droits" probably overlaps "note-decisions": anchor it with "below": "note-decisions" instead of x and y.']);
});

it("finds nothing when the sticky is anchored below the note", () => {
  expect(
    issues([
      { kind: "text", id: "note-decisions", text: LONG, width: 420, rightOf: "sortie.html", gap: 60 },
      { kind: "sticky", id: "q-droits", text: "Who can edit?", below: "note-decisions" },
    ]),
  ).toEqual([]);
});

it("reports a note covering an artboard, and an arrow crossing a box on its way", () => {
  expect(issues([{ kind: "sticky", id: "ask", text: "?", x: 200, y: 200 }])).toEqual(['"ask" probably covers the artboard "sortie.html": move it beside the artboard, e.g. "rightOf": "sortie.html".']);
  expect(
    issues([
      // Long enough for q2 to sit below the artboard, so the arrow goes up across the note and q1.
      { kind: "text", id: "note", text: [LONG, LONG, LONG].join("\n"), width: 420, rightOf: "sortie.html", gap: 60 },
      { kind: "sticky", id: "q1", text: "First question", below: "note" },
      { kind: "sticky", id: "q2", text: "Second question", below: "q1" },
      { kind: "arrow", id: "to-q2", from: "sortie.html", to: "q2" },
    ]),
  ).toEqual(['The arrow "to-q2" crosses "note" and "q1": link boxes with nothing between them, or leave the arrow out.']);
});

it("leaves shapes, which frame other boxes on purpose, and unnamed elements by their index", () => {
  expect(issues([{ kind: "shape", shape: "rect", id: "frame", x: -40, y: -40, width: 1520, height: 980 }])).toEqual([]);
  expect(issues([{ kind: "sticky", text: "?", x: 200, y: 200 }])).toEqual(['elements[0] (sticky) probably covers the artboard "sortie.html": move it beside the artboard, e.g. "rightOf": "sortie.html".']);
});

it("reports artboards that overlap each other", () => {
  expect(issues([], [{ file: "a.html", x: 0, y: 0, width: 400, height: 300 }, { file: "b.html", x: 200, y: 0, width: 400, height: 300 }, { file: "c.html", x: 700, y: 0, width: 400, height: 300 }])).toEqual([
    'The artboards "b.html" and "a.html" overlap: move one of them.',
  ]);
});
