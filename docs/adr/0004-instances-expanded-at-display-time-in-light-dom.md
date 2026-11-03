# Instances are expanded at display time, in light DOM; the stored file keeps the tags

Only a component's CSS used to be shared: a session copied the component's HTML into the mock-up, so a structure change in the design system never reached existing pages. A mock-up now places an **instance** (`<ui-modal size="sm">` with its content in slots) and Redline expands it when the artboard is served: an instance runtime injected next to the bridge defines one custom element per **component definition** and renders the component's `<template data-component>` into the element. The page file is never rewritten, so its version history shows what the mock-up decided and a design system change reaches every page at the next diffusion (ADR 0002 decides which definitions a page sees: the current diffusion's for a project page, the draft for a design system page and for the "Aperçu" of a pending diffusion). Definitions are frozen in each diffusion with the rest of the components.

The instance renders in **light DOM** (no shadow root): the global component CSS, comment selectors, the hover outline, "Voir" and the gaps report keep working on what is displayed.

## Considered Options

- **Rewrite the page HTML when the design system changes**: rejected because the page file would hold generated markup, histories would fill with machine edits, and a half-applied rewrite could leave pages inconsistent.
- **Expand on the server when serving**: rejected because the instance must re-render when its attributes change and later react to clicks (`opens`, `closes`), which needs a runtime in the artboard anyway.
- **Shadow DOM**: rejected because it hides the displayed elements from the global CSS, from selectors used by comments and from the bridge.
- **Allow detaching an instance**: rejected on purpose: a detached copy is the drift this change removes.
