import { CORE_TOKENS, DEFAULT_ARTBOARD_HEIGHT, DEFAULT_ARTBOARD_WIDTH, MANIFEST_PATH, TWEAKS_PATH } from "@redline/shared";

/** What a session needs to know to edit a Redline page; returned by the `read_guide` tool. */
export const REDLINE_GUIDE = `# Redline guide

A Redline page is a set of files. You work on a copy of them (the working copy folder given in your first message) and write nowhere else. When your run ends, every change is published as one version.

## Artboards and ${MANIFEST_PATH}
- An artboard is a self-contained HTML file. ${MANIFEST_PATH} at the root of the page lists them and is the layout source of truth.
- Shape: { "title", "type": "prototype" | "comparison", "designSystem": "<id>", "artboards": [{ "file", "title", "width", "height", "x", "y" }], "notes": [{ "text", "x", "y" }], "links": [{ "from", "selector", "to" }], "tweaks": [...] }.
- Positions and sizes are canvas pixels. Default size is ${DEFAULT_ARTBOARD_WIDTH}x${DEFAULT_ARTBOARD_HEIGHT}. A missing x puts the artboard right of the previous one.
- artboards[].file is the artboard's identity: comment threads reference it, so do not rename or delete a file with open threads.
- To add an artboard, use the add_artboard tool (it writes the HTML and the manifest entry). To change a manifest section by hand, keep the file valid JSON: an invalid manifest is rejected when the run is published.
- links make clicks on a CSS selector in artboard "from" go to artboard "to" in play mode.

## Design system tokens
- The artboard server injects the page's design system stylesheet into every artboard. Never add your own link to it and never hard-code colors, fonts, radii or spacing that a token covers.
- Core tokens, always available: ${CORE_TOKENS.join(", ")}.
- Use them as var(--color-primary), var(--font-body), calc(var(--space-unit) * 2). A design system may define extra tokens.

## Tweaks
- A tweak is a live control the user can change without asking you. Declare it in ${MANIFEST_PATH} "tweaks": { "id", "type", "label", "default", "options", "min", "max" }.
- Types: color (#rgb or #rrggbb), choice (one of options), toggle (boolean), range (number in [min, max]), count (integer in [min, max]), text (string).
- Values never go in the manifest. They live in ${TWEAKS_PATH}, a flat JSON object { "<tweakId>": value }. A missing id uses the declared default.
- Artboards receive values without reloading: CSS variable --tweak-<id> on <html> (toggle is 1 or 0), attribute data-tweak-<id>, window.redlineTweaks, and a "redline:tweaks" event on window (detail = values).
- Style with var(--tweak-accent, #e5484d) or html[data-tweak-layout="grid"] ...; for text or count, read window.redlineTweaks and listen to "redline:tweaks" to re-render. Always provide fallbacks: the first paint happens before the values arrive.

## Rules
- Artboards run in a sandboxed iframe: scripts are allowed, but no same-origin access, no cookies or storage, no network assumptions. Keep each artboard self-contained.
- Answer each comment thread you were given with reply_in_thread, once per thread.
- Use create_page for a new page in the same project; it starts with a manifest and starter artboards. Its content is not in your working copy.
`;
