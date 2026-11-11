# Changelog

Every release of Redline, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/) in its `0.x` form: until `1.0.0`, a minor bump (`0.2.0`) may break the CLI, the MCP tools or the agent protocol, a patch bump (`0.2.1`) never does.

Add a line under **Unreleased** with every change worth telling (a merged lot, a user-visible fix). `npm run release -- <version>` turns that section into the release. See `docs/releasing.md`.

## [Unreleased]

### Fixed

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
