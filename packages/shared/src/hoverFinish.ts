/**
 * Hover outline finish (board "HoverOutline", finish B). One place for the values: the artboard bridge
 * embeds them, and the web canvas imports them to outline canvas elements the same way.
 * Dropping the white halo later means setting `outlineHalo` and `labelEdge` to "none".
 */
export const HOVER_FINISH = {
  color: "#D92D20",
  labelText: "#FFFFFF",
  outlineWidth: 2,
  outlineOffset: 2,
  /** box-shadow of the outline: spread measured from the element's border box. */
  outlineHalo: "0 0 0 5px #FFFFFF",
  /** box-shadow of the label. */
  labelEdge: "0 0 0 1px #FFFFFF",
  labelFont: "600 11px/1 Inter, system-ui, sans-serif",
  labelPadding: "4px 6px",
  labelRadius: 4,
  /** Label offset from the element's top-left corner (border box). */
  labelOffsetX: -4,
  labelOffsetY: -26,
} as const;

/** Style of the outline box; the caller adds position, size and border-radius. */
export function hoverOutlineCss(): string {
  const f = HOVER_FINISH;
  return `outline: ${f.outlineWidth}px solid ${f.color}; outline-offset: ${f.outlineOffset}px; box-shadow: ${f.outlineHalo}`;
}

/** Style of the label; the caller adds the position. */
export function hoverLabelCss(): string {
  const f = HOVER_FINISH;
  return `background: ${f.color}; color: ${f.labelText}; font: ${f.labelFont}; padding: ${f.labelPadding}; border-radius: ${f.labelRadius}px; white-space: nowrap; letter-spacing: 0; box-shadow: ${f.labelEdge}`;
}

/** Numbered selection mark (board "ConversationChips"): the outline above plus a round badge at the element's top-left corner. */
export const MARK_FINISH = {
  badgeSize: 22,
  /** Badge offset from the element's top-left corner (border box). */
  badgeOffset: -14,
  badgeEdge: "0 0 0 2px #FFFFFF",
  badgeFont: "700 12px/22px Inter, system-ui, sans-serif",
} as const;

/** Style of a mark badge; the caller adds position. */
export function markBadgeCss(): string {
  const f = MARK_FINISH;
  return `width: ${f.badgeSize}px; height: ${f.badgeSize}px; border-radius: 50%; background: ${HOVER_FINISH.color}; color: ${HOVER_FINISH.labelText}; font: ${f.badgeFont}; text-align: center; box-shadow: ${f.badgeEdge}`;
}

/** Outline of the element a design system gap points at ("Voir", board DsAudit); the caller adds position, size and border-radius. */
export const GAP_OUTLINE_CSS = "outline: 2px dashed #EA580C; outline-offset: 3px";

/**
 * Outline and label of the component instance around the hovered element (board "InstComments"): dashed, in the dark
 * chrome colour, so it reads apart from the red outline of the element itself.
 */
export const INSTANCE_FINISH = {
  color: "#27272a",
  outlineWidth: 2,
  outlineOffset: 2,
} as const;

/** Style of the instance outline; the caller adds position, size and border-radius. */
export function instanceOutlineCss(): string {
  const f = INSTANCE_FINISH;
  return `outline: ${f.outlineWidth}px dashed ${f.color}; outline-offset: ${f.outlineOffset}px`;
}

/** Style of the instance label ("ui-modal · confirm"); the caller adds the position. */
export function instanceLabelCss(): string {
  return `${hoverLabelCss()}; background: ${INSTANCE_FINISH.color}`;
}
