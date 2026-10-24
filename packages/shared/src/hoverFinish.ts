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
