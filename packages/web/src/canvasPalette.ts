import type { PaletteColor } from "@redline/shared";

/** Shades of one palette colour: `fill` paints a surface, `stroke` an outline or line, `text` is readable on `fill` and on the canvas. */
export interface PaletteShades {
  fill: string;
  stroke: string;
  text: string;
}

export type CanvasTheme = "light" | "dark";

const LIGHT: Record<PaletteColor, PaletteShades> = {
  yellow: { fill: "#FEF3C7", stroke: "#FACC15", text: "#422006" },
  orange: { fill: "#FFEDD5", stroke: "#EA580C", text: "#431407" },
  pink: { fill: "#FCE7F3", stroke: "#DB2777", text: "#500724" },
  green: { fill: "#DCFCE7", stroke: "#16A34A", text: "#052E16" },
  blue: { fill: "#DBEAFE", stroke: "#1D4ED8", text: "#172554" },
  purple: { fill: "#EDE9FE", stroke: "#7C3AED", text: "#2E1065" },
  gray: { fill: "#F4F4F5", stroke: "#3F3F46", text: "#18181B" },
};

const DARK: Record<PaletteColor, PaletteShades> = {
  yellow: { fill: "#713F12", stroke: "#FACC15", text: "#FEF9C3" },
  orange: { fill: "#7C2D12", stroke: "#FB923C", text: "#FFEDD5" },
  pink: { fill: "#831843", stroke: "#F472B6", text: "#FCE7F3" },
  green: { fill: "#14532D", stroke: "#4ADE80", text: "#DCFCE7" },
  blue: { fill: "#1E3A8A", stroke: "#60A5FA", text: "#DBEAFE" },
  purple: { fill: "#4C1D95", stroke: "#A78BFA", text: "#EDE9FE" },
  gray: { fill: "#3F3F46", stroke: "#A1A1AA", text: "#F4F4F5" },
};

export const PALETTE: Record<CanvasTheme, Record<PaletteColor, PaletteShades>> = { light: LIGHT, dark: DARK };

/** The canvas is light today; pass `"dark"` once a dark canvas exists. */
export function paletteShades(color: PaletteColor, theme: CanvasTheme = "light"): PaletteShades {
  return PALETTE[theme][color];
}
