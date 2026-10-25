/** One custom property of a design system's `tokens.css`. */
export interface TokenDeclaration {
  name: string;
  value: string;
  /** True when the value is a literal colour (the UI offers a colour picker). */
  isColor: boolean;
  /** Set on a deprecated alias written `--old: var(--new); /* deprecated: renamed to --new *\/`. */
  deprecatedFor?: string;
}

const DECLARATION =
  /(--[A-Za-z0-9_-]+)\s*:\s*((?:"[^"]*"|'[^']*'|\([^)]*\)|[^;{}"'(])*?)\s*(?:;\s*(?:\/\*\s*deprecated:\s*renamed to\s+(--[A-Za-z0-9_-]+)\s*\*\/)?|(?=\}))/g;

const NAMED_COLORS = new Set(
  (
    "transparent currentcolor black white red green blue yellow orange purple pink gray grey brown cyan magenta lime navy teal olive maroon silver aqua fuchsia " +
    "gold indigo violet coral salmon tomato crimson khaki ivory beige lavender turquoise tan orchid plum azure"
  ).split(" "),
);

export function isColorValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v) ||
    /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(.*\)$/.test(v) ||
    NAMED_COLORS.has(v)
  );
}

/**
 * Custom properties declared in a `tokens.css`, in order. A name declared twice keeps its first position and its
 * last value (CSS cascade).
 */
export function parseTokens(css: string): TokenDeclaration[] {
  const plain = css.replace(/\/\*(?!\s*deprecated:)[\s\S]*?\*\//g, "");
  const byName = new Map<string, TokenDeclaration>();
  for (const [, name, rawValue, deprecatedFor] of plain.matchAll(DECLARATION)) {
    const value = rawValue.trim();
    byName.set(name, { name, value, isColor: isColorValue(value), ...(deprecatedFor ? { deprecatedFor } : {}) });
  }
  return [...byName.values()];
}
