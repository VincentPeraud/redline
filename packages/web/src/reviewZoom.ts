import { fitToStage, scrollTagLabel, type Presentation, type ScrollFit } from "./playFrames.js";

/** How a review step shows its artboard: as it opens ("natural": today's fit, a tall one at its width to scroll), whole in the stage ("fit"), or at a chosen scale. */
export type ReviewZoom = "natural" | "fit" | number;

export const MIN_REVIEW_ZOOM = 0.1;
export const MAX_REVIEW_ZOOM = 3;
/** One click on + or − (as on the page canvas). */
const ZOOM_STEP = 1.25;
/** A tall artboard opens fitted when fitting keeps at least this share of its scrolled scale (a carousel slide); below, it would be too small to read (a long page). */
const READABLE_SHARE = 0.5;

export interface ReviewFit {
  viewport: { width: number; height: number };
  scale: number;
  scroll: ScrollFit | "zoom";
  /** The scale that shows the whole artboard in the stage. */
  fitScale: number;
  /** A presentation stretched to the stage has nothing to zoom. */
  zoomable: boolean;
}

const clamp = (value: number) => Math.min(MAX_REVIEW_ZOOM, Math.max(MIN_REVIEW_ZOOM, value));

/** Room for the scaled artboard: the stage less its padding and the frame's decoration. */
function room(presentation: Presentation, stage: { width: number; height: number }) {
  return { width: stage.width - presentation.stagePadding * 2, height: stage.height - presentation.stagePadding * 2 - presentation.frameHeight };
}

/** Whole artboard in the stage. */
function fitScaleOf(presentation: Presentation, stage: { width: number; height: number }): number {
  const { width, height } = room(presentation, stage);
  return clamp(Math.min(width / presentation.viewport.width, height / presentation.viewport.height));
}

/** The mode a step opens in: fitted when the artboard stays readable whole, else today's fit. */
export function openingZoom(presentation: Presentation, stage: { width: number; height: number }): "natural" | "fit" {
  const natural = fitToStage(presentation, stage);
  if (presentation.fill !== "none" || !natural.scroll) return "natural";
  return fitScaleOf(presentation, stage) >= READABLE_SHARE * natural.scale ? "fit" : "natural";
}

/**
 * Viewport, scale and scroll of the artboard for a zoom. `scrolling`, when given, is the scroll decision taken
 * before: entering or leaving the scroll changes the stage padding, so the measured stage would make it flip back.
 */
export function reviewFit(presentation: Presentation, stage: { width: number; height: number }, zoom: ReviewZoom, scrolling?: boolean): ReviewFit {
  const natural = fitToStage(presentation, stage);
  // An unframed phone / tablet takes the stage's height, but never less than its own: a short stage (group thumbnails under it) scrolls instead of squashing it.
  // The held decision wins: scrolling drops the stage padding, so the measured stage would make it flip back.
  if (presentation.fill === "height" && stage.width > 0 && (scrolling ?? natural.viewport.height < presentation.viewport.height)) {
    return { viewport: presentation.viewport, scale: natural.scale, scroll: natural.scale < 1 ? "width" : "real", fitScale: natural.scale, zoomable: false };
  }
  if (presentation.fill !== "none" || stage.width === 0) return { ...natural, fitScale: natural.scale, zoomable: false };
  const fitScale = fitScaleOf(presentation, stage);
  if (zoom === "natural") {
    const scroll = scrolling === undefined ? natural.scroll : scrolling ? (natural.scroll ?? "real") : null;
    return { ...natural, scroll, fitScale, zoomable: true };
  }
  const scale = zoom === "fit" ? fitScale : clamp(zoom);
  const { width, height } = room(presentation, stage);
  const overflows = presentation.viewport.width * scale > width + 0.5 || presentation.viewport.height * scale > height + 0.5;
  const scroll = (scrolling ?? overflows) ? "zoom" : null;
  return { viewport: presentation.viewport, scale, scroll, fitScale, zoomable: true };
}

/** One step in or out from `scale`, within the limits. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  return clamp(direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP);
}

/** The tag over a scrolled artboard: its zoom when the person chose one. */
export function zoomTagLabel(scroll: Exclude<ReviewFit["scroll"], null>, scale: number, size: { width: number; height: number }): string {
  if (scroll === "zoom") return `${Math.round(scale * 100)} % · ${size.width} × ${size.height} · fais défiler`;
  return scrollTagLabel(scroll, size);
}
