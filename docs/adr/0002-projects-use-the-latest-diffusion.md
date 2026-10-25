# Projects use the latest diffusion; each page version records its diffusion

A shared design system used to be served live from its page: any edit reached every project at once. It is now edited as a *draft* and projects use the latest **diffusion**, a numbered, immutable snapshot (assembled `tokens.css`, `components.css`, DESIGN.md, component list and index, stored as content-addressed blobs per ADR 0001) that the user creates explicitly. The design system points at its current diffusion, and each page version records the diffusion number current when it was published, so history can later be drawn with the design system of its time. Versions published before diffusions existed count as diffusion 1.

## Considered Options

- **Keep serving the design system live**: rejected because a half-finished edit, or a session working on the design system, would change every project's rendering unseen.
- **Pin each project to a diffusion**: rejected for now (out of the lot): projects always follow the current diffusion, which keeps the model to one pointer per design system.
- **Version the design system like a page (a version per edit)**: rejected because a page version is a save, not a decision to spread; diffusions are the unit the user reviews, announces ("diffusion 13") and rolls back.
