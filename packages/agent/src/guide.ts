import { ASSETS_DIR, CORE_TOKENS, DEFAULT_ARTBOARD_HEIGHT, DEFAULT_ARTBOARD_WIDTH, MANIFEST_PATH, MAX_ASSET_BYTES, MAX_PAGE_BYTES, TWEAKS_PATH } from "@redline/shared";

/** What a session needs to know to edit a Redline page; returned by the `read_guide` tool. */
export const REDLINE_GUIDE = `# Redline guide

A Redline page is a set of files. You work on a copy of them (the working copy folder given in your first message) and write nowhere else. When your run ends, every change is published as one version.

## Artboards and ${MANIFEST_PATH}
- An artboard is a self-contained HTML file. ${MANIFEST_PATH} at the root of the page lists them and is the layout source of truth.
- Shape: { "title", "designSystem": "<id>", "artboards": [{ "file", "title", "width", "height", "x", "y" }], "elements": [{ "kind": "title", "text", "subtitle", "width", "x", "y" }], "links": [{ "from", "selector", "to" }], "tweaks": [...] }.
- Positions and sizes are canvas pixels. Default size is ${DEFAULT_ARTBOARD_WIDTH}x${DEFAULT_ARTBOARD_HEIGHT}. A missing x puts the artboard right of the previous one.
- artboards[].file is the artboard's identity: comment threads reference it, so do not rename or delete a file with open threads.
- To add an artboard, use the add_artboard tool (it writes the HTML and the manifest entry). To change a manifest section by hand, keep the file valid JSON: an invalid manifest is rejected when the run is published.
- elements is an ordered list of decorations drawn on the canvas, in list order. Each has a "kind"; "title" is the default when kind is absent. They are not draggable, take no comments and do not appear in play mode. An unknown kind is rejected when the run is published. The old "notes" list still reads as titles, but never use it together with "elements".
- title: a big group title above a row of artboards: { "kind": "title", "text", "subtitle" (optional), "width" (max width, default 1200), "x", "y" }. Put it above the first artboard of the group (y about -120, x equal to the artboard's x). A title too long for its width shrinks to half its size then ends with "…"; the subtitle stops at two lines. Keep both short: the canvas shows no artboard count, write it in the subtitle if useful.
- link: a 640x112 card to another Redline page or to an external URL: { "kind": "link", "page": "<page id>", "x", "y" } shows the page's title, thumbnail and project and opens it in the same tab; { "kind": "link", "url": "https://...", "title", "x", "y" } shows the given title and the URL's domain and opens it in a new tab (http or https only). Give either page, or url with title, never both: anything else is rejected when the run is published, naming the field. Place cards outside the artboards (for example below them); a card is 640 wide, so leave 640x112 of free canvas.
- Each artboard declares how play mode presents it with "device": "phone" | "tablet" | "desktop" | "paper" | "none" (phone frame, tablet frame, browser window, white sheet on grey, or the design as is). Always set a device on every new artboard. "url" (desktop only) is the text of the browser's address bar: set it only when the design has a real address, otherwise leave it out (the bar stays empty).
- "expand": "fill" on an artboard makes play mode stretch that artboard to the whole window (the canvas keeps the declared width and height). Use it for dashboards and other fluid pages that are reviewed at the viewer's screen size; build them with relative sizes, not fixed pixels. It has no effect on a phone artboard.
- artboards[].guides = { "columns", "gutter", "margin", "baseline"? } (pixels, columns a whole number) declares a column grid on that artboard; viewers show it with the Guides (G) button. Design the artboard to that grid.
- links make clicks on a CSS selector in artboard "from" go to artboard "to" in play mode.

## Design system tokens
- The artboard server injects the page's design system stylesheet into every artboard. Never add your own link to it and never hard-code colors, fonts, radii or spacing that a token covers.
- Core tokens, always available: ${CORE_TOKENS.join(", ")}.
- Use them as var(--color-primary, #d92d20), var(--font-body, system-ui, sans-serif), calc(var(--space-unit, 8px) * 2). Always give a fallback value: an artboard opened outside Redline (a file preview, an export) gets no tokens, and a var() without fallback drops the font or the colour. A design system may define extra tokens.

## Tweaks
- A tweak is a live control the user can change without asking you. Declare it in ${MANIFEST_PATH} "tweaks": { "id", "type", "label", "default", "options", "min", "max", "unit", "display", "allowCustom", "scope" }.
- Types: color (#rgb or #rrggbb), choice (one of options), toggle (boolean), range (number in [min, max]), count (integer in [min, max]), text (string). "boolean" and "int" are accepted as names for toggle and count.
- Optional fields: color "options" (suggested swatches, e.g. ["#D92D20", "#0F766E"]) and "allowCustom": true (adds a free colour picker); choice "display": "buttons" (default), "dropdown" or "previews" (live thumbnails of the first artboard rendered with each option); text "options" (suggested phrasings, the user can still type their own); range and count "unit" ("px", "cartes"); "scope": "element", "artboard" or "page" (what the tweak touches; the panel lists element, then artboard, then page tweaks).
- Name a tweak after what it controls (spacing, font, screenState, header), not after its type. Fonts, screen states and variants are plain choices.
- Values never go in the manifest. They live in ${TWEAKS_PATH}, a flat JSON object { "<tweakId>": value }. A missing id uses the declared default.
- Artboards receive values without reloading: CSS variable --tweak-<id> on <html> (toggle is 1 or 0), attribute data-tweak-<id>, window.redlineTweaks, and a "redline:tweaks" event on window (detail = values).
- Style with var(--tweak-accent, #e5484d) or html[data-tweak-layout="grid"] ...; for text or count, read window.redlineTweaks and listen to "redline:tweaks" to re-render. Always provide fallbacks: the first paint happens before the values arrive.

## Assets (images and fonts)
- Images and fonts go in ${ASSETS_DIR}/ of the working copy, never inline in the HTML (no data: URLs, no base64). They are the project's assets, shared by every page of the project, and ${ASSETS_DIR}/ already holds the existing ones: reuse them before adding a file.
- Reference them relative to the page root: src="${ASSETS_DIR}/hero.jpg", url(${ASSETS_DIR}/fonts/inter.woff2); from an artboard in a subfolder, ../${ASSETS_DIR}/hero.jpg.
- A new or changed file in ${ASSETS_DIR}/ is uploaded when your run ends (in terminal mode, on each publish_page) (${MAX_ASSET_BYTES / 1024 / 1024} MB at most per file). Deleting or renaming one has no effect, since other pages may use it. Overwriting one changes it on every page that uses it: to change an image for this page only, add a file with a new name.

## Rules
- Artboards run in a sandboxed iframe: scripts are allowed, but no same-origin access, no cookies or storage, no network assumptions. Keep each artboard self-contained, apart from the project assets.
- Answer each comment thread you were given with reply_in_thread, once per thread.
- A page has no type: it is a canvas of one or more artboards. Never call a page a "planche"; say "page" or "artboard".
- Use create_page {title} for a new page in the same project; it starts empty (a manifest, no artboard). Its content is not in your working copy. Say in your answer that you created it (the user sees a link card to the page under your answer).
- In terminal mode (redline mcp), list_projects and list_pages {projectId} find projects and pages, create_project {title} makes a project, and create_page {title, projectId} works without a checked-out page; then checkout_page the new page to add its artboards.
- A published version carries ${MAX_PAGE_BYTES / 1024 / 1024} MB at most: images and fonts go in ${ASSETS_DIR}/, never inline.

## DESIGN.md (the project's rules)
- DESIGN.md at the root of the working copy holds the project's design rules, read by every session. You may edit it (plain Markdown; one rule per line or list item, e.g. "- Primary buttons are always full width on mobile").
- Add a rule when the user takes a decision that should apply to FUTURE artboards too (a naming, a spacing, a component behaviour, a tone of voice), not for a one-off change to the artboard being discussed. Do not rewrite, reorder or delete existing rules unless the user asks; add a line (or edit the one that changes).
- When you add or change a rule, say it in your answer ("I also added to DESIGN.md: ...") so the user can disagree. The change is published with the run and shown with its origin.
`;
