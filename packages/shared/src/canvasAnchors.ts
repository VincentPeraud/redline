import type { ManifestElement } from "./index.js";

/** A rectangle in canvas pixels. */
export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The elements with every anchored one placed against its target: below it (left edges aligned) or right of it (top edges
 * aligned), `gap` away. `sizeOf` gives an element's rendered size (measured on the canvas); a chain is followed whatever the
 * declaration order. An element whose target is missing or part of a loop (refused at publish) keeps x 0, y 0.
 */
export function placeAnchoredElements(
  elements: ManifestElement[],
  artboardBoxes: ReadonlyMap<string, CanvasBox>,
  sizeOf: (element: ManifestElement) => { width: number; height: number },
): ManifestElement[] {
  const byId = new Map(elements.flatMap((element) => (element.id !== undefined ? [[element.id, element] as const] : [])));
  const placed = new Map<ManifestElement, ManifestElement>();
  const placing = new Set<ManifestElement>();

  const place = (element: ManifestElement): ManifestElement => {
    const done = placed.get(element);
    if (done) return done;
    if (!("anchor" in element) || !element.anchor || placing.has(element)) return element;
    placing.add(element);
    const { side, target, gap } = element.anchor;
    const targetElement = byId.get(target);
    const box = artboardBoxes.get(target) ?? (targetElement ? boxOf(place(targetElement)) : undefined);
    placing.delete(element);
    const result = box ? { ...element, ...(side === "below" ? { x: box.x, y: box.y + box.height + gap } : { x: box.x + box.width + gap, y: box.y }) } : element;
    placed.set(element, result);
    return result;
  };
  const boxOf = (element: ManifestElement): CanvasBox | undefined => {
    if (!("x" in element)) return undefined;
    const { width, height } = sizeOf(element);
    return { x: element.x, y: element.y, width, height };
  };

  return elements.map(place);
}
