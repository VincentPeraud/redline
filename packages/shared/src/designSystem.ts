// Design systems (ticket 26). A design system is a special project with one page whose files
// include `tokens.css`; artboards read it live from the artboard origin.

import type { ModelChoice } from "./work.js";

export const DESIGN_SYSTEM_TOKENS_PATH = "tokens.css";

/** Id of the design system seeded on first start and used when a page names none. */
export const NEUTRAL_DESIGN_SYSTEM_ID = "neutral";

/** Custom properties every design system must define, so any page works with any design system. */
export const CORE_TOKENS = [
  "--color-primary",
  "--color-on-primary",
  "--color-background",
  "--color-surface",
  "--color-text",
  "--color-text-muted",
  "--color-border",
  "--font-heading",
  "--font-body",
  "--radius",
  "--space-unit",
] as const;

export interface DesignSystem {
  /** Same as the id of the underlying project, and the value of a manifest's `designSystem`. */
  id: string;
  title: string;
  /** The page showing tokens and components; publish new versions of it to change the design system. */
  pageId: string;
}

/** A design system as listed: with the projects whose `designSystem` it is. */
export interface DesignSystemSummary extends DesignSystem {
  usedBy: { id: string; title: string }[];
  /** Time of the last version of the design system's page. */
  updatedAt?: string;
}

export interface CreateDesignSystemRequest extends ModelChoice {
  title: string;
  /** File path -> UTF-8 content; must include `tokens.css` defining every core token. Omitted = the neutral starter files. */
  files?: Record<string, string>;
  /** Project whose pages Claude derives the design system from (dispatched like a conversation message). */
  fromProjectId?: string;
  /** Optional instructions: the first message of the design system's first conversation. */
  instructions?: string;
}

/** Core tokens that `css` does not declare. */
export function missingCoreTokens(css: string): string[] {
  return CORE_TOKENS.filter((token) => !new RegExp(`(^|[\\s;{])${token}\\s*:`).test(css));
}

/** Path on the artboard origin serving a design system's tokens, live. */
export function designSystemTokensUrlPath(designSystemId: string): string {
  return `/design-systems/${encodeURIComponent(designSystemId)}/${DESIGN_SYSTEM_TOKENS_PATH}`;
}

export const NEUTRAL_TOKENS_CSS = `:root {
  --color-primary: #18181b;
  --color-on-primary: #ffffff;
  --color-background: #ffffff;
  --color-surface: #f4f4f5;
  --color-text: #18181b;
  --color-text-muted: #52525b;
  --color-border: #e4e4e7;
  --font-heading: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-body: system-ui, -apple-system, "Segoe UI", sans-serif;
  --radius: 6px;
  --space-unit: 8px;
}
`;

const SWATCHES = CORE_TOKENS.filter((token) => token.startsWith("--color-"));

export const NEUTRAL_TOKENS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tokens</title>
<style>
  body { margin: 0; padding: calc(var(--space-unit) * 4); background: var(--color-background); color: var(--color-text); font-family: var(--font-body); }
  h1 { font-family: var(--font-heading); }
  .swatches { display: flex; flex-wrap: wrap; gap: var(--space-unit); }
  .swatch { width: 140px; border: 1px solid var(--color-border); border-radius: var(--radius); overflow: hidden; font-size: 12px; }
  .swatch div { height: 56px; }
  .swatch p { margin: 0; padding: var(--space-unit); color: var(--color-text-muted); }
  button { background: var(--color-primary); color: var(--color-on-primary); border: 0; border-radius: var(--radius); padding: var(--space-unit) calc(var(--space-unit) * 2); font-family: var(--font-body); }
</style>
</head>
<body>
<h1>Tokens</h1>
<div class="swatches">
${SWATCHES.map((token) => `  <div class="swatch"><div style="background: var(${token})"></div><p>${token}</p></div>`).join("\n")}
</div>
<h1>Components</h1>
<button>Primary button</button>
</body>
</html>
`;

/** Files of a design system created from scratch: the core tokens at their neutral values plus a preview page. */
export function starterDesignSystemFiles(): Record<string, string> {
  return { [DESIGN_SYSTEM_TOKENS_PATH]: NEUTRAL_TOKENS_CSS, "index.html": NEUTRAL_TOKENS_PAGE_HTML };
}
