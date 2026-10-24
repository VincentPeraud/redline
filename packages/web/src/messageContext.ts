import { resolveTweakValues, type Manifest, type MessageContext, type ThreadRendering, type TweakValue, type TweakValues } from "@redline/shared";
import type { Box } from "./canvasGeometry.js";
import type { CanvasView } from "./canvasView.js";

interface Input {
  view: CanvasView;
  /** The canvas viewport. The side panel is a sibling of it, so it never covers part of it. */
  viewport: { width: number; height: number };
  boxes: Map<string, Box>;
  manifest?: Manifest | null;
  tweakValues?: TweakValues;
  /** Set in play mode: the artboard shown (and its rendering) is the only visible one. */
  play?: { file: string; rendering?: ThreadRendering };
}

const tweakValueText = (value: TweakValue, unit: string | undefined): string => {
  if (typeof value === "boolean") return value ? "oui" : "non";
  return unit ? `${value} ${unit}` : String(value);
};

const overlaps = (box: Box, view: CanvasView, viewport: Input["viewport"]) =>
  box.x * view.zoom + view.x < viewport.width &&
  (box.x + box.width) * view.zoom + view.x > 0 &&
  box.y * view.zoom + view.y < viewport.height &&
  (box.y + box.height) * view.zoom + view.y > 0;

/** What goes with a conversation message: artboards on screen (any overlap counts) and the tweaks with their current values. */
export function messageContext({ view, viewport, boxes, manifest, tweakValues = {}, play }: Input): MessageContext {
  const visibleArtboards = play
    ? [{ file: play.file, ...(play.rendering && { rendering: play.rendering }) }]
    : [...boxes].filter(([, box]) => overlaps(box, view, viewport)).map(([file]) => ({ file }));
  const values = manifest ? resolveTweakValues(manifest, tweakValues) : {};
  const tweaks = (manifest?.tweaks ?? []).map((tweak) => ({ label: tweak.label, value: tweakValueText(values[tweak.id] ?? "", tweak.unit) }));
  return { visibleArtboards, tweaks };
}

/** The "Contexte transmis" chips: the page, the visible artboards, and the tweaks (absent without tweaks). */
export function contextChips(pageTitle: string, artboardCount: number, context: MessageContext): string[] {
  const files = context.visibleArtboards.map((a) => a.file.replace(/\.[^./]+$/, ""));
  return [
    `${pageTitle} · ${artboardCount} ${artboardCount > 1 ? "artboards" : "artboard"}`,
    `Visibles : ${files.length > 0 ? files.join(", ") : "aucun"}`,
    ...(context.tweaks.length > 0 ? [`Tweaks : ${context.tweaks.map((t) => `${t.label.toLowerCase()} ${t.value}`).join(", ")}`] : []),
  ];
}
