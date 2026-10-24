import type { CSSProperties } from "react";
import { HOVER_FINISH, MARK_FINISH } from "@redline/shared";

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

/** The numbered badge of a selection mark (board `ConversationChips`); the caller adds the position. */
export const markBadgeStyle: CSSProperties = {
  width: MARK_FINISH.badgeSize,
  height: MARK_FINISH.badgeSize,
  borderRadius: "50%",
  background: HOVER_FINISH.color,
  color: HOVER_FINISH.labelText,
  font: MARK_FINISH.badgeFont,
  textAlign: "center",
  boxShadow: MARK_FINISH.badgeEdge,
};
