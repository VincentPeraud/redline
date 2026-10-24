# Redline

Redline is a mock-up tool for Claude Code: pages and comments live on a server, while the AI sessions that edit them run on the user's own machines.

## Language

### Design content

**Project**:
A set of pages sharing one DESIGN.md, one asset folder and one design system.

**Page**:
A canvas grouping one or more artboards, described by a manifest. A page has no type: it is just a canvas of artboards.
_Avoid_: Planche (also for a page of variants), board, artefact, page type, prototype / comparison

**Artboard**:
One HTML file placed on a page's canvas.
_Avoid_: Écran, screen, planche (in the UI: always "artboard")

**Reading order**:
The order in which a page's artboards are numbered: artboards whose vertical extents overlap form a row, rows go top to bottom and artboards of a row left to right, whatever the manifest order. Each artboard also falls under a group (the nearest group title above its row that covers it horizontally, or none).
_Avoid_: Manifest order, artboard order

**Design system**:
A special project whose tokens, components and pages define a style that other projects use.
_Avoid_: DS (in code and docs), theme, style guide

**Core tokens**:
The fixed set of named design variables every design system must define, so pages work with any design system.
_Avoid_: Base variables, required tokens

**Tweak**:
A setting declared on a page (color, choice, toggle, range, count, text) whose chosen value is part of the design.
_Avoid_: Variant, option, control

**Version**:
A saved state of a page's files, created each time a session publishes; any version can be restored.
_Avoid_: Commit, revision, snapshot

### Talking to the AI

**Thread**:
A comment with its replies, aimed at one of three targets: an element of an artboard (pinned), a whole artboard, or a canvas element; it ends when resolved.
_Avoid_: Fil de commentaires, comment (for the whole exchange)

**Canvas element**:
A title, text, sticky note, link, image, shape or arrow placed directly on a page's canvas, described in its manifest and identified by a stable id; a thread or a chip can target it.
_Avoid_: Object, widget, annotation

**Chip**:
A numbered element the user points at in a conversation message (an artboard element, a whole artboard or a canvas element); the message refers to it by its number.
_Avoid_: Tag, attachment, mention

**Conversation**:
A free-form exchange attached to a page, with no pin; it ends when archived.
_Avoid_: Chat, discussion

**Held comment**:
A finished comment the user keeps back ("Plus tard") so it is sent later together with other held comments of the same page, in one message.
_Avoid_: Draft, batch item

**Session**:
One AI CLI session serving a conversation, a single thread, or the threads sent together in one message; it is resumed for each new reply in any of them.

**Working copy**:
The local copy of a page's files that an agent downloads for a session to edit, then publishes back as a new version.
_Avoid_: Draft, checkout, sandbox

**Engine**:
The AI CLI an agent drives to run sessions; v1 supports Claude Code only.
_Avoid_: Model, provider

### Machines

**Agent**:
A process running on one of the user's machines, in one folder, that picks up threads and conversations and runs their sessions.
_Avoid_: Worker, runner, bot

**Project agent**:
An agent started in a project's code folder; a project has at most one.

**Global agent**:
An agent started in a neutral folder that serves projects without a project agent, and those whose project agent is offline when the user allows it.

### People

**User**:
The single owner of a Redline server; v1 has no other people.
_Avoid_: Account, member
