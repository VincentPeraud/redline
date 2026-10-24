import type { CSSProperties } from "react";
import { HOVER_FINISH } from "@redline/shared";

/** The hover outline of board `HoverOutline` (finish B) as React styles; every value comes from the shared finish. */
export const hoverOutlineStyle: CSSProperties = {
  outline: `${HOVER_FINISH.outlineWidth}px solid ${HOVER_FINISH.color}`,
  outlineOffset: HOVER_FINISH.outlineOffset,
  boxShadow: HOVER_FINISH.outlineHalo,
};

export const hoverLabelStyle: CSSProperties = {
  background: HOVER_FINISH.color,
  color: HOVER_FINISH.labelText,
  font: HOVER_FINISH.labelFont,
  padding: HOVER_FINISH.labelPadding,
  borderRadius: HOVER_FINISH.labelRadius,
  whiteSpace: "nowrap",
  letterSpacing: 0,
  boxShadow: HOVER_FINISH.labelEdge,
};
