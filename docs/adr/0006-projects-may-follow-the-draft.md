# Projects may follow the design system draft

Amends ADR 0002. A project used to see only the current **diffusion** of its shared design system, so building a design system from a pilot project cost one diffusion per step: every component added in the draft had to be diffused before a page could use it, and the diffusion stopped being a decision. A project now has a setting, "Ce projet suit": the latest diffusion (the default, ADR 0002 unchanged) or the **design system draft**.

The design system still has one pointer, its current diffusion. A project on the draft sees the draft everywhere it used to read that pointer: artboard rendering, the `.design-system/` folder of a checkout, publish checks on instances, gaps and the component name check. Each page version records the diffusion it follows (as before) plus a flag "published on the draft"; history draws such a version with the draft as it stands, since the draft is not snapshotted. One module (`design-system-view.ts`) decides what a project sees.

## Considered Options

- **Pin a project to a diffusion**: still rejected (ADR 0002): one pointer per design system.
- **A private diffusion per project**: rejected: it brings back one diffusion per step.
- **Diffuse automatically on every draft change**: rejected: diffusion stays the unit the user reviews, announces and rolls back; stabilised projects stay on diffusions.
- **Snapshot the draft per published version**: rejected: storage and complexity for a state meant to change.

## Consequences

- Pages of a project on the draft can change without the project publishing anything; the user knows because the setting is explicit, and (later tickets) the page shows a band while the draft differs from the diffusion.
- Going back to the latest diffusion can break pages that use draft-only elements; that switch is guarded (later tickets).
