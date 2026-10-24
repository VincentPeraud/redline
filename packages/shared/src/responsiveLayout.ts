import { RESPONSIVE_SPACING, renderingKey, type ArtboardRendering } from "./index.js";

interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderingSlot {
  /** `renderingKey` of the rendering: the identity that measured heights and hidden sets refer to. */
  key: string;
  width: number;
  /** Declared viewport height, used until the page height is measured. */
  height: number;
}

export interface ResponsiveFrameLayout {
  frame: LayoutBox;
  renderings: (LayoutBox & { key: string })[];
}

export interface ResponsiveFrameOptions {
  /** Real document height of each rendering, by key, as reported by the artboard bridge. */
  measuredHeights?: Readonly<Record<string, number>>;
  /** Renderings left out of the frame; it closes up around the others. */
  hidden?: ReadonlySet<string>;
}

/** Renderings side by side from the frame's top-left corner; one spacing step is both the frame's padding and the gap between renderings. */
export function responsiveFrameLayout(origin: { x: number; y: number }, slots: readonly RenderingSlot[], { measuredHeights = {}, hidden }: ResponsiveFrameOptions = {}): ResponsiveFrameLayout {
  let x = origin.x + RESPONSIVE_SPACING;
  const renderings = slots
    .filter((slot) => !hidden?.has(slot.key))
    .map((slot) => {
      const box = { key: slot.key, x, y: origin.y + RESPONSIVE_SPACING, width: slot.width, height: measuredHeights[slot.key] ?? slot.height };
      x += slot.width + RESPONSIVE_SPACING;
      return box;
    });
  const tallest = Math.max(0, ...renderings.map((r) => r.height));
  return { frame: { x: origin.x, y: origin.y, width: x - origin.x, height: tallest + 2 * RESPONSIVE_SPACING }, renderings };
}

export const renderingSlots = (renderings: readonly ArtboardRendering[]): RenderingSlot[] =>
  renderings.map((rendering) => ({ key: renderingKey(rendering), width: rendering.width, height: rendering.height }));

