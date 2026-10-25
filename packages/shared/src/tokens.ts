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

const maskComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Declarations of one token in comment-masked css, with the spans of their value and of the whole declaration. */
function declarationsOf(masked: string, name: string): { valueStart: number; valueEnd: number; start: number; end: number }[] {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_-])${escapeRegExp(name)}\\s*:\\s*((?:"[^"]*"|'[^']*'|\\([^)]*\\)|[^;{}"'(])*?)\\s*(?:;|(?=\\}))`,
    "dg",
  );
  return [...masked.matchAll(pattern)].map((match) => ({
    valueStart: match.indices![1][0],
    valueEnd: match.indices![1][1],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Why a value cannot be written to a token declaration, or null. */
export function tokenValueError(value: string): string | null {
  if (value.trim() === "") return "value is required";
  if (/[;{}\n\r]|\/\*|\*\//.test(value)) return "value must not contain ; { } line breaks or comments";
  return null;
}

/** `css` with the token set to `value`: the last declaration is edited in place, else the token ends the last `:root` block. */
export function setToken(css: string, name: string, value: string): string {
  const masked = maskComments(css);
  const last = declarationsOf(masked, name).at(-1);
  if (last) return css.slice(0, last.valueStart) + value + css.slice(last.valueEnd);
  const declaration = `  ${name}: ${value};\n`;
  const rootStart = [...masked.matchAll(/:root\s*\{/g)].at(-1)?.index;
  const close = rootStart === undefined ? -1 : masked.indexOf("}", rootStart);
  if (close < 0) return `${css}${css === "" || css.endsWith("\n") ? "" : "\n"}${css === "" ? "" : "\n"}:root {\n${declaration}}\n`;
  const before = css.slice(0, close);
  const lineStart = /\n[ \t]*$/.exec(before);
  if (lineStart) return css.slice(0, lineStart.index + 1) + declaration + css.slice(lineStart.index + 1);
  const trimmed = before.trimEnd();
  return `${trimmed}${/[;{]$/.test(trimmed) ? "" : ";"}\n${declaration}${css.slice(close)}`;
}

/** `css` without the declarations of the token (a declaration alone on its line takes the line with it). */
export function removeToken(css: string, name: string): string {
  const masked = maskComments(css);
  let result = css;
  for (const { start, end } of declarationsOf(masked, name).reverse()) {
    const note = /^[ \t]*\/\*\s*deprecated:[\s\S]*?\*\//.exec(result.slice(end));
    const to = end + (note?.[0].length ?? 0);
    const before = /(^|\n)[ \t]*$/.exec(result.slice(0, start));
    const after = /^[ \t]*(\n|$)/.exec(result.slice(to));
    result = before && after ? result.slice(0, before.index + before[1].length) + result.slice(to + after[0].length) : result.slice(0, start) + result.slice(to);
  }
  return result;
}
