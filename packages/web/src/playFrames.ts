import type { ArtboardFrame, ArtboardRendering, ManifestArtboard, ResponsiveFormat } from "@redline/shared";

/** A phone artboard plays in a real phone viewport, so responsive designs reflow. */
const PHONE_VIEWPORT = { width: 390, height: 760 };
/** Height of the decorative strip under a tablet screen (home indicator) and over a browser page (browser bar). */
const TABLET_STRIP_HEIGHT = 22;
const BROWSER_BAR_HEIGHT = 36;

/** What is drawn around the iframe: an artboard frame, or `none` (the design as is). */
export type PresentationFrame = ArtboardFrame | "none";

export interface Presentation {
  frame: PresentationFrame;
  /** Size of the page the iframe renders, before scaling to the stage. */
  viewport: { width: number; height: number };
  /** Decorative height added around the viewport by the frame. */
  frameHeight: number;
  /** Space kept free around the frame on the stage. */
  stagePadding: number;
  /** Whether the viewport stretches to the stage: its height (phone/tablet keep their width) or both sizes. */
  fill: "none" | "height" | "both";
  /** A frame applies, so the "Habillage" button is offered. */
  framable: boolean;
  /** Narrow-window phone: a dark bar with a back button sits above the design. */
  mobileBar: boolean;
}

/** Window widths under which a phone / tablet artboard fills the screen, as on the real device. */
const PHONE_FILL_BELOW = 600;
const TABLET_FILL_BELOW = 1100;

const FRAME_OF_FORMAT: Record<ResponsiveFormat, ArtboardFrame> = { desktop: "browser", "tablet-landscape": "tablet", tablet: "tablet", mobile: "phone" };

/** `framed` false drops the frame and shows the design as is (the "Habillage" switch). `rendering`: the chosen format of a responsive artboard (its frame at its own size); `null` = "Aucun", the whole window. */
export function presentationOf(
  artboard: Pick<ManifestArtboard, "width" | "height" | "frame" | "expand">,
  framed = true,
  windowWidth = Number.POSITIVE_INFINITY,
  rendering?: ArtboardRendering | null,
): Presentation {
  if (rendering === null) return { frame: "none", viewport: { width: artboard.width, height: artboard.height }, frameHeight: 0, stagePadding: 0, fill: "both", framable: false, mobileBar: false };
  if (rendering) {
    const frame = FRAME_OF_FORMAT[rendering.format];
    const size = { width: rendering.width, height: rendering.height };
    return { ...presentationOf({ ...size, frame }, framed, windowWidth), viewport: size };
  }
  /* No declared frame: the artboard is not a screen or a document: shown as is. */
  const declared = artboard.frame ?? "none";
  const expanded = artboard.expand === "fill" && declared !== "phone";
  const narrow = (declared === "phone" && windowWidth < PHONE_FILL_BELOW) || (declared === "tablet" && windowWidth < TABLET_FILL_BELOW);
  const framable = declared !== "none" && declared !== "paper" && !narrow && !expanded;
  const frame = (framed || declared === "paper") && !narrow && !expanded ? declared : "none";
  const fill = narrow || expanded ? "both" : framable && !framed ? (declared === "browser" ? "both" : "height") : "none";
  const viewport = declared === "phone" ? PHONE_VIEWPORT : { width: artboard.width, height: artboard.height };
  return {
    frame,
    viewport,
    frameHeight: frame === "tablet" ? TABLET_STRIP_HEIGHT : frame === "browser" ? BROWSER_BAR_HEIGHT : 0,
    stagePadding: fill !== "none" ? 0 : frame === "paper" ? 14 : frame === "browser" ? 44 : 32,
    fill,
    framable,
    mobileBar: narrow && declared === "phone",
  };
}
