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

**Artboard address**:
The link to one artboard: the page route followed by `/artboards/<file>` (file URI-encoded). Opening it loads the page's canvas, centres it on the artboard and outlines it once; panning and zooming never rewrite it.
_Avoid_: Artboard URL, deep link

**Reading order**:
The order in which a page's artboards are numbered: artboards whose vertical extents overlap form a row, rows go top to bottom and artboards of a row left to right, whatever the manifest order. Each artboard also falls under a group (the nearest group title above its row that covers it horizontally, or none).
_Avoid_: Manifest order, artboard order

**Design system**:
A special project whose tokens, components and pages define a style that other projects use.
_Avoid_: DS (in code and docs), theme, style guide

**Diffusion**:
A numbered (1, 2, ...), immutable snapshot of a shared design system (its `tokens.css`, `components.css`, DESIGN.md, component list and index) that projects use. The design system points at its current diffusion; its own pages and everything edited since are the **draft**, and the changes between the draft and the current diffusion are **pending** until the user creates a new diffusion. Projects only ever see diffused files.
_Avoid_: Release, publish, version (a version is a saved state of one page)

**Project style**:
A project's own tokens (project-level `tokens.css`, next to DESIGN.md), injected after the design system's. With a shared design system it holds the project's overrides; without one it is the project's whole style, starting from the neutral values.
_Avoid_: Theme, project layer, local design system

**Override**:
A project-style token that replaces the design system's token of the same name; its CSS comes later, so the project value wins.
_Avoid_: Customisation, exception

**Component**:
An artboard file `components/<name>.html` of a page of a design system or of a project; its name is its file name (`[a-z0-9-]`). Its style lives in `<style data-component>` blocks, its description in `<meta name="description">`, its usage in `<template data-usage>`; its variants are the tweaks of its artboard and its states go through `data-state` or modifier classes. Redline assembles the components of a design system, or of a project, into a `components.css` served to artboards; the canvas marks a component with a ◆ and its name on the strip. Two components of one design system or one project cannot share a name.
_Avoid_: Widget, block, symbol

**Core tokens**:
The fixed set of named design variables every design system must define, so pages work with any design system.
_Avoid_: Base variables, required tokens

**Tweak**:
A setting declared on a page (color, choice, toggle, range, count, text) whose chosen value is part of the design.
_Avoid_: Variant, option, control

**Tweak grid**:
An artboard rendered once per combination of up to three of its tweaks (rows, columns, blocks), drawn as one labelled frame.
_Avoid_: Matrix (the manifest key only), variant sheet

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
