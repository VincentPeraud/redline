import type { ArtboardDevice, ManifestArtboard } from "@redline/shared";

/** Undeclared artboards up to this width and in portrait are presented as a phone. */
const PHONE_MAX_WIDTH = 500;
/** A phone artboard plays in a real phone viewport, so responsive designs reflow. */
const PHONE_VIEWPORT = { width: 390, height: 760 };
/** Height of the decorative strip under a tablet screen (home indicator) and over a desktop page (browser bar). */
const TABLET_STRIP_HEIGHT = 22;
const BROWSER_BAR_HEIGHT = 36;

export interface Presentation {
  device: ArtboardDevice;
  /** Size of the page the iframe renders, before scaling to the stage. */
  viewport: { width: number; height: number };
  /** Decorative height added around the viewport by the device frame. */
  frameHeight: number;
  /** Space kept free around the device on the stage. */
  stagePadding: number;
}

/** `framed` false drops the device frame and shows the design as is (the "Habillage" switch). */
export function presentationOf(artboard: Pick<ManifestArtboard, "width" | "height" | "device">, framed = true): Presentation {
  const declared = artboard.device ?? (artboard.width <= PHONE_MAX_WIDTH && artboard.height > artboard.width ? "phone" : "none");
  const device = framed ? declared : "none";
  const viewport = declared === "phone" ? PHONE_VIEWPORT : { width: artboard.width, height: artboard.height };
  return {
    device,
    viewport,
    frameHeight: device === "tablet" ? TABLET_STRIP_HEIGHT : device === "desktop" ? BROWSER_BAR_HEIGHT : 0,
    stagePadding: device === "paper" ? 14 : device === "desktop" ? 44 : 32,
  };
}
