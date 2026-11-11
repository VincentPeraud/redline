# Changelog

Every release of Redline, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/) in its `0.x` form: until `1.0.0`, a minor bump (`0.2.0`) may break the CLI, the MCP tools or the agent protocol, a patch bump (`0.2.1`) never does.

Add a line under **Unreleased** with every change worth telling (a merged lot, a user-visible fix). `npm run release -- <version>` turns that section into the release. See `docs/releasing.md`.

## [Unreleased]

### Added

- The agents screen's Comments tab lists, for every installation, the pages whose threads wait for a terminal session (who holds the page, each comment with author, time and target, `o` opens the page in Redline). It reads them through the new read-only `GET /agent-api/terminal-comments`, which never takes a thread.
- `redline doctor` prints the command and agent host versions, the MCP registration, each installation (SemVer, plus a short build hash when two builds share a version, token, reachability) with the command that fixes each problem, skipped folders under `instances/`, and the current folder's link. It also works before `redline migrate`.
- The server has an instance name (`REDLINE_INSTANCE_NAME`, for example "Lumora"): `/api/config` returns it with the version and the build hash, and the Agents page shows "<name> · v<version>" next to its title. The production compose project name is now a setting (`REDLINE_COMPOSE_PROJECT`, default `redline`) so a second copy can run on the same host.
- `redline setup <address> [--name <name>]` creates one installation per Redline instance under the CLI config dir (`instances/<id>/`: its own login and the build its server serves), named after the server, registers the `redline` MCP once, and refuses while the old single login exists. The same address again replaces the token and restarts the agents the old token had stopped. The server answers `GET /agent-api/instance` (name, version, build hash) for the CLI.
- `redline link [<instance>]` links a folder to an instance without a project or an agent. One resolver (nearest link, here or in a parent) tells which installation a folder uses; `redline mcp` now hands over, in the same process, to that installation's own MCP, whose answers and instructions start with "Instance: <name> (<address>, v<version>)". A folder with no link on a computer with several instances, or linked to an address not installed here, gets a `setup_needed` tool telling what to run. A link may name an address with no project.
- The agent host runs each agent with its own installation's code and token (a Lumora agent and a Local agent can run different builds side by side), speaks a host protocol version (the server's `/agent-api/instance` and the installed build tell it), accepts the current and the previous version, and refuses an older installation with a message naming it and both versions. When the global `redline` command changes, the host restarts once no run is in progress on any installation (idle agents wait offline meanwhile, no run is ever cancelled), starts its agents again and says "Host restarted" in their logs. `redline agent --global --instance <name|address>` picks the instance (`--server` stays an alias), and the instance questions of `redline agent` name the instances with their address and version.
- `redline migrate [--now] [--name <address>=<name>]` moves the old single login to one installation per server (token moved, build installed, agents attached by address), waits for runs in progress unless `--now`, stops the agent host and marks its agents "Stopped by redline migrate.", and is idempotent. A server whose name is taken stays in the old login. Until every server is migrated, every command but `migrate`, `doctor` and `help` refuses, bare `redline` prints the migrate message and every MCP tool answers it. The panel's `npx ... setup` command installs the global `redline` command when it is missing or older, and migrates first on an old computer.
- `redline update <instance|address>` installs the server's current build into one installation (a failed install changes nothing), then the agent host restarts every agent of that installation after its current run (never cancelling one); the browser's "Mettre à jour" restarts the installation's other agents the same way. The global `redline` command is refreshed only from a newer build, so updating an older instance never downgrades it. A server too old for the command, or with nothing newer, is said plainly. `redline remove <instance>` removes an installation and its stopped agents, and refuses while one of its agents or a Claude Code session of it runs (the MCP launcher records live sessions per installation); linked folders keep their link and report it as not installed. In Claude Code, only the sessions of an updated installation pause, with a message naming the installation and both versions, and an installation behind its server tells the user to run `redline update <address>`.
- The "Lancer un agent" panel gives one command, `npx -y <server>/cli/redline-cli.tgz setup <server> --token <token>`, a "Lier un dossier" step (`redline link <instance>`), the global agent with `--instance`, a line saying other instances keep their own version and `redline doctor` checks them, and the instance badge. On the Agents page a refused agent's row shows and copies `redline update <address>`, or `npx -y <server>/cli/redline-cli.tgz migrate` with an explanation when the agent was installed before instances (the agent's hello now carries its host protocol, absent before instances); the server's refusal message names the same command.
- A "Présenter" button in the page's top bar plays the page from its first artboard in reading order.
- Bare `redline` opens the agents screen in a terminal (`redline agents` stays an alias); `redline help`, and bare `redline` outside a terminal, print the commands. The screen shows a "This folder" line (`l` links an unlinked folder to an instance), tabs Agents, Instances and Comments with their counts (Tab or 1 2 3), ← → to move the focus between the log and the list, "↑ n more" / "↓ n more" on a long list, each agent's instance before its model and effort and an Instance field, and `?` for the keys and commands. `n` picks the instance first (one too old for the command is dimmed and refused), and an agent stopped by `redline migrate` says so. The Comments tab is a placeholder for now.
- The Instances tab of the agents screen lists the installations, problems first (update available, too old, token refused, unreachable, then up to date), each with its version and state, a "! n" count on the tab and "checking" per installation while its server answers. The left pane is doctor for the selected one (installed and server versions, token, agents, linked folders, Claude Code sessions, what to do); ↑↓ scrolls it when it has the focus. `u` updates and `x` removes the selected installation as `redline update` and `redline remove` do, with their refusals shown in the screen, and `s` closes the screen to run `redline setup` (address and token asked in the terminal).

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
