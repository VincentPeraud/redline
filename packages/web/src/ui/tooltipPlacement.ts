export interface Box {
  width: number;
  height: number;
}

export interface TriggerBox extends Box {
  left: number;
  top: number;
}

export interface TooltipPlacement {
  side: "top" | "bottom";
  /** Viewport coordinates of the bubble's top-left corner. */
  left: number;
  top: number;
  /** Centre of the arrow, measured from the bubble's left edge. */
  arrowLeft: number;
}

const GAP = 6;
const VIEWPORT_MARGIN = 8;
const ARROW_INSET = 7;

/** Centres the bubble above its trigger (under it when there is no room), then keeps it inside the viewport while the arrow still points at the trigger. */
export function placeTooltip(trigger: TriggerBox, bubble: Box, viewport: Box): TooltipPlacement {
  const fitsAbove = trigger.top - GAP - bubble.height >= VIEWPORT_MARGIN;
  const side = fitsAbove ? "top" : "bottom";
  const top = fitsAbove ? trigger.top - GAP - bubble.height : trigger.top + trigger.height + GAP;
  const triggerCentre = trigger.left + trigger.width / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - bubble.width);
  const left = Math.min(Math.max(triggerCentre - bubble.width / 2, VIEWPORT_MARGIN), maxLeft);
  const arrowLeft = Math.min(Math.max(triggerCentre - left, ARROW_INSET), bubble.width - ARROW_INSET);
  return { side, left, top, arrowLeft };
}
