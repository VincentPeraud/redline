// Layout check of a page's canvas, for sessions: what probably overlaps, covers an artboard or is crossed by an arrow. The
// server renders nothing, so note heights are estimated from their text (the canvas measures them; see canvasAnchors).

import { arrowGeometry } from "./arrowGeometry.js";
import { placeAnchoredElements, type CanvasBox } from "./canvasAnchors.js";
import { LINK_CARD_HEIGHT, LINK_CARD_WIDTH, NOTE_FONT_SIZE, type Manifest, type ManifestElement, type ManifestStickyElement, type ManifestTextElement } from "./index.js";

/** Average glyph width of the canvas font, as a share of its size. */
const GLYPH_WIDTH = 0.5;
/** Padding (em) and line height of each note kind, as in CanvasNotes.module.css; a text note also has a 2 px border. */
const NOTE_METRICS = {
  text: { padX: 0.9, padY: 0.6, lineHeight: 1.5, border: 2 },
  sticky: { padX: 1, padY: 0.85, lineHeight: 1.42, border: 0 },
} as const;
/** Bullet list indent (em). */
const LIST_INDENT = 1.3;
/** Overlaps thinner than this are rounding, not a layout problem. */
const TOLERANCE = 8;

/** Size of a text note or sticky as the canvas would render it, estimated from its width, size and text. */
export function estimatedNoteSize(note: ManifestTextElement | ManifestStickyElement): { width: number; height: number } {
  const font = NOTE_FONT_SIZE[note.size];
  const { padX, padY, lineHeight, border } = NOTE_METRICS[note.kind];
  const inner = note.width - 2 * padX * font - 2 * border;
  const lines = note.text.split("\n").reduce((sum, line) => {
    const bullet = /^\s*[-*] /.test(line);
    const text = line.replace(/^\s*[-*] /, "").replace(/\*\*|\*|\[([^\]]*)\]\([^)]*\)/g, "$1");
    const perLine = Math.max(1, Math.floor((inner - (bullet ? LIST_INDENT * font : 0)) / (GLYPH_WIDTH * font)));
    return sum + Math.max(1, Math.ceil(text.length / perLine));
  }, 0);
  return { width: note.width, height: Math.round(lines * lineHeight * font + 2 * padY * font + 2 * border) };
}

/** Estimated size of the elements the check knows; titles and images (their height follows the image) are left out. */
function estimatedSize(element: ManifestElement): { width: number; height: number } | null {
  switch (element.kind) {
    case "text":
    case "sticky":
      return estimatedNoteSize(element);
    case "link":
      return { width: LINK_CARD_WIDTH, height: LINK_CARD_HEIGHT };
    case "shape":
      return { width: element.width, height: element.height };
    default:
      return null;
  }
}

const overlap = (a: CanvasBox, b: CanvasBox) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > TOLERANCE && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > TOLERANCE;
const inside = (point: { x: number; y: number }, box: CanvasBox) =>
  point.x > box.x + TOLERANCE && point.x < box.x + box.width - TOLERANCE && point.y > box.y + TOLERANCE && point.y < box.y + box.height - TOLERANCE;

/** What a session is told about its canvas layout, one sentence per problem (English); empty when nothing is wrong. */
export function pageLayoutIssues(manifest: Manifest): string[] {
  const artboards = new Map(manifest.artboards.map((a) => [a.file, { x: a.x, y: a.y, width: a.width, height: a.height }]));
  const placed = placeAnchoredElements(manifest.elements, artboards, (element) => estimatedSize(element) ?? { width: 0, height: 0 });
  const nameOf = (element: ManifestElement, i: number) => (element.id !== undefined ? `"${element.id}"` : `elements[${i}] (${element.kind})`);
  const boxes = placed.flatMap((element, i) => {
    const size = element.kind === "title" || element.kind === "arrow" ? null : estimatedSize(element);
    return size && "x" in element ? [{ element, name: nameOf(element, i), box: { x: element.x, y: element.y, ...size } }] : [];
  });
  const issues: string[] = [];

  const files = [...artboards];
  files.forEach(([file, box], i) => {
    for (const [other, otherBox] of files.slice(0, i)) if (overlap(box, otherBox)) issues.push(`The artboards "${file}" and "${other}" overlap: move one of them.`);
  });

  // Shapes frame other boxes on purpose: only the other kinds are checked.
  const checked = boxes.filter(({ element }) => element.kind !== "shape");
  checked.forEach((a, i) => {
    for (const b of checked.slice(0, i)) {
      if (!overlap(a.box, b.box)) continue;
      const anchor = b.element.id !== undefined ? `anchor it with "below": "${b.element.id}" instead of x and y` : "move it";
      issues.push(`${a.name} probably overlaps ${b.name}: ${anchor}.`);
    }
    for (const [file, box] of artboards) {
      if (overlap(a.box, box)) issues.push(`${a.name} probably covers the artboard "${file}": move it beside the artboard, e.g. "rightOf": "${file}".`);
    }
  });

  const boxOf = (target: string) => artboards.get(target) ?? boxes.find(({ element }) => element.id === target)?.box;
  placed.forEach((element, i) => {
    if (element.kind !== "arrow") return;
    const from = typeof element.from === "string" ? boxOf(element.from) : element.from;
    const to = typeof element.to === "string" ? boxOf(element.to) : element.to;
    if (!from || !to) return;
    const ends = [element.from, element.to];
    const { samples } = arrowGeometry(from, to);
    const crossed = [
      ...checked.filter(({ element: other }) => other.id === undefined || !ends.includes(other.id)).map(({ name, box }) => ({ name, box })),
      ...[...artboards].filter(([file]) => !ends.includes(file)).map(([file, box]) => ({ name: `the artboard "${file}"`, box })),
    ].filter(({ box }) => samples.some((point) => inside(point, box)));
    if (crossed.length > 0) issues.push(`The arrow ${nameOf(element, i)} crosses ${crossed.map((c) => c.name).join(" and ")}: link boxes with nothing between them, or leave the arrow out.`);
  });
  return issues;
}
