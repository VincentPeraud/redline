import type { CSSProperties } from "react";
import type { ManifestShapeElement } from "@redline/shared";
import { paletteShades } from "./canvasPalette.js";
import { cx } from "./ui/index.js";
import styles from "./CanvasShapes.module.css";

/** Share of the tint colour in the light `fill` style. */
const FILL_OPACITY_PERCENT = 15;

export function CanvasShape({ element }: { element: ManifestShapeElement }) {
  const { stroke, tint } = paletteShades(element.color);
  const style: CSSProperties = { left: element.x, top: element.y, width: element.width, height: element.height, color: stroke };
  if (element.style === "outline") style.borderColor = stroke;
  else style.background = `color-mix(in srgb, ${tint} ${FILL_OPACITY_PERCENT}%, transparent)`;
  return (
    <div data-canvas-shape className={cx(styles.shape, styles[element.shape], element.style === "outline" && styles.outline)} style={style}>
      {element.label && <div className={styles.label}>{element.label}</div>}
    </div>
  );
}
