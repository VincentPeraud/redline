import type { ArtboardDevice, ArtboardRendering, ManifestArtboard, ResponsiveFormat } from "@redline/shared";

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

const DEVICE_OF_FORMAT: Record<ResponsiveFormat, ArtboardDevice> = { desktop: "desktop", "tablet-landscape": "tablet", tablet: "tablet", mobile: "phone" };

/** `framed` false drops the device frame and shows the design as is (the "Habillage" switch). `rendering`: the chosen format of a responsive artboard (its device at its own size); `null` = "Aucun", the whole window. */
export function presentationOf(
  artboard: Pick<ManifestArtboard, "width" | "height" | "device" | "expand">,
  framed = true,
  windowWidth = Number.POSITIVE_INFINITY,
  rendering?: ArtboardRendering | null,
): Presentation {
  if (rendering === null) return { device: "none", viewport: { width: artboard.width, height: artboard.height }, frameHeight: 0, stagePadding: 0, fill: "both", framable: false, mobileBar: false };
  if (rendering) {
    const device = DEVICE_OF_FORMAT[rendering.format];
    const size = { width: rendering.width, height: rendering.height };
    return { ...presentationOf({ ...size, device }, framed, windowWidth), viewport: size, mobileBar: false };
  }
  const declared = artboard.device ?? (artboard.width <= PHONE_MAX_WIDTH && artboard.height > artboard.width ? "phone" : "none");
  const expanded = artboard.expand === "fill" && declared !== "phone";
  const narrow = (declared === "phone" && windowWidth < PHONE_FILL_BELOW) || (declared === "tablet" && windowWidth < TABLET_FILL_BELOW);
  const device = framed && !narrow && !expanded ? declared : "none";
  const framable = declared !== "none" && !narrow && !expanded;
  const fill = narrow || expanded ? "both" : framable && !framed ? (declared === "desktop" ? "both" : declared === "paper" ? "none" : "height") : "none";
  const viewport = declared === "phone" ? PHONE_VIEWPORT : { width: artboard.width, height: artboard.height };
  return {
    device,
    viewport,
    frameHeight: device === "tablet" ? TABLET_STRIP_HEIGHT : device === "desktop" ? BROWSER_BAR_HEIGHT : 0,
    stagePadding: fill !== "none" ? 0 : device === "paper" ? 14 : device === "desktop" ? 44 : 32,
    fill,
    framable,
    mobileBar: narrow && declared === "phone",
  };
}
