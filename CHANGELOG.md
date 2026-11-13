# Changelog

Every release of Redline, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/) in its `0.x` form: until `1.0.0`, a minor bump (`0.2.0`) may break the CLI, the MCP tools or the agent protocol, a patch bump (`0.2.1`) never does.

Add a line under **Unreleased** with every change worth telling (a merged lot, a user-visible fix). `npm run release -- <version>` turns that section into the release. See `docs/releasing.md`.

## [Unreleased]

### Added

- Review mode: a terminal session declares a review of its changes with `request_review`; members with Écriture open the link, go through the steps (page order, then reading order) in a red review screen, answer OK (cancellable), finish the review, and the conversation reads the result with `review_feedback`.
- Review mode: pages covered by a review show a banner under the canvas header (requested, in progress, finished waiting for fetch, fetched), and review changes reach other members live.
- Review mode: a member can write a remark instead of an OK on a step (saved as they type, editable and deletable with an undo until the review is finished, others' answers shown under "Les autres"); when the conversation fetches the review, each remark becomes a thread on its artboard, taken by that session and answerable with `reply_in_thread`.
- Review mode: `review_feedback` works without an id (the one finished review of the folder's projects is fetched, several are listed, none finished reports the open ones with their progress), any conversation of a member with Écriture can fetch, a second fetch returns the same result marked already fetched, only terminal sessions can call `request_review`, and members without Écriture get a refusal screen.
- Review mode: a review can cover several pages (steps listed by page in the counter menu); a new `request_review` from the same conversation merges into its open review (a redeclared step gets the new question and keeps its remarks), another conversation opens its own review, and a declaration refuses unknown files and artboards of another project.
- Review mode: the recap shows the counts, every remark with its author (edit or delete your own, with an undo), the OKs and the steps not seen in two columns; finishing asks for confirmation when steps were not seen or another member is still in the review; a finished review can be reopened by any member with Écriture until it is fetched, or filed without sending (final, after a confirmation naming the remarks never sent), and `review_feedback` on a filed review answers "classée sans envoi par X le …". A step that turns read-only while a member types keeps their unsaved text with a "Copier" button.
- Review mode: an artboard republished after an answer turns its step to "Modifié depuis ta revue" (tag naming the author of the new version, red progress segment, "Modifié" in the menu); the member checks again with "Revoir et valider" or "Effacer ma remarque et valider", and Claude gets modified OK-only steps as not seen and modified remarks marked "artboard modifié depuis la remarque". A terminal publish now records the folder of its session.
- A "Présenter" button in the page's top bar plays the page from its first artboard in reading order.

### Changed

- The page menu of a project with many pages scrolls inside a bounded height, opens on the current page, and keeps "Vue du projet" in view.

### Fixed

- Behind a proxy or an SSO, the page stopped updating live ("Claude is working on this thread" stayed, "Résoudre" seemed to do nothing until a reload): the event stream now pings every 25 s, asks proxies not to buffer it, opens again when it is cut and reloads what the screen shows; resolving or reopening a thread updates the list at once.
- On Linux, a Claude Code crash showed "Claude Code ended without a result." instead of its own error message.

## [0.1.0] - 2026-11-10

### Added

- Accounts, sign-in and sharing.
- `browser_sign_in` terminal MCP tool: a single-use agent sign-in link for headless test browsers.
- Component instances: one HTML per component, every mock-up follows it.
- Terminal comments: new comment threads wait for the terminal session that last published the page.
- Background agents: agent host in the background, agents screen in the terminal.
- Archive, unarchive and delete projects, design systems and pages; read-only archived pages; blob garbage collection.
- Self-hosting: installable Redline behind an existing SSO, signed actions, one-command setup.
- A project without a design system gets the style Claude designs for it.
- Design systems: live design systems, project style, components, diffusions, tweak grid, artboard strips, gaps.
- Addresses and navigation: artboard addresses, table of contents, play URLs, cross-page links.
- Comments and conversations: hover outline, whole-artboard and canvas-element threads, message context and chips.
- Canvas elements (text, stickies, shapes, arrows, images, links), frames, responsive artboards, canvas overview.
- One folder can serve several projects; `redline init` is gone.
- `rename_project`, `archive_project` and `rename_page` MCP tools.
- Artboard errors and fit-to-content height.

### Changed

- Artboards take a `frame` instead of a `device`.
- Comment pins sit on their element and are found again by name.
- Phone frames start under an iOS status bar tinted with the page's top colour.

### Fixed

- Many open tabs no longer freeze Redline: one live event stream is shared across tabs.
