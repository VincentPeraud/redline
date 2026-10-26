import { LINK_CARD_HEIGHT, LINK_CARD_WIDTH, renderingSlots, responsiveFrameLayout, type ArtboardRendering, type ManifestElement, type ResponsiveFrameOptions } from "@redline/shared";

export { renderingSlots, responsiveFrameLayout };
export type { RenderingSlot, ResponsiveFrameLayout, ResponsiveFrameOptions } from "@redline/shared";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Point, Size {}

export { arrowGeometry } from "@redline/shared";
export type { ArrowGeometry } from "@redline/shared";

/** Box of an element on the canvas, or null for an arrow. Link cards have a fixed size; the others use the size measured in the DOM. */
export function elementBox(element: ManifestElement, measured: Size | undefined): Box | null {
  switch (element.kind) {
    case "arrow":
      return null;
    case "link":
      return { x: element.x, y: element.y, width: LINK_CARD_WIDTH, height: LINK_CARD_HEIGHT };
    case "shape":
      return { x: element.x, y: element.y, width: element.width, height: element.height };
    default:
      return { x: element.x, y: element.y, width: measured?.width ?? element.width, height: measured?.height ?? 0 };
  }
}

/** Box an arrow targets for a responsive artboard: the whole frame. */
export function responsiveFrameBox(artboard: { x: number; y: number; responsive: readonly ArtboardRendering[] }, options?: ResponsiveFrameOptions): Box {
  return responsiveFrameLayout(artboard, renderingSlots(artboard.responsive), options).frame;
}
