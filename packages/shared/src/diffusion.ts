// Diffusions (lot E, ticket 09). A diffusion is a numbered, immutable snapshot of a design system that projects
// use; this pure module compares two assembled states of a design system.

import { parseTokens } from "./tokens.js";

/** What a diffusion (or the draft) holds, reduced to what the diff compares. */
export interface DiffusionState {
  tokensCss: string;
  designMd: string;
  /** Components by name with the content hash of their file. */
  components: { name: string; hash: string }[];
}

export interface DiffusionDiff {
  tokens: {
    changed: { name: string; from: string; to: string }[];
    added: { name: string; value: string }[];
    removed: { name: string; value: string }[];
  };
  components: { added: string[]; changed: string[]; removed: string[] };
  designMdChanged: boolean;
  /** Number of changes: tokens, components and DESIGN.md. 0 = nothing pending. */
  count: number;
}

export function diffDiffusionStates(from: DiffusionState, to: DiffusionState): DiffusionDiff {
  const before = new Map(parseTokens(from.tokensCss).map((t) => [t.name, t]));
  const after = new Map(parseTokens(to.tokensCss).map((t) => [t.name, t]));
  const tokens: DiffusionDiff["tokens"] = { changed: [], added: [], removed: [] };
  for (const [name, token] of after) {
    const old = before.get(name);
    if (!old) tokens.added.push({ name, value: token.value });
    else if (old.value !== token.value) tokens.changed.push({ name, from: old.value, to: token.value });
  }
  for (const [name, token] of before) if (!after.has(name)) tokens.removed.push({ name, value: token.value });

  const oldHashes = new Map(from.components.map((c) => [c.name, c.hash]));
  const newHashes = new Map(to.components.map((c) => [c.name, c.hash]));
  const components: DiffusionDiff["components"] = {
    added: to.components.filter((c) => !oldHashes.has(c.name)).map((c) => c.name),
    changed: to.components.filter((c) => oldHashes.has(c.name) && oldHashes.get(c.name) !== c.hash).map((c) => c.name),
    removed: from.components.filter((c) => !newHashes.has(c.name)).map((c) => c.name),
  };
  const designMdChanged = from.designMd !== to.designMd;
  const count =
    tokens.changed.length + tokens.added.length + tokens.removed.length +
    components.added.length + components.changed.length + components.removed.length +
    (designMdChanged ? 1 : 0);
  return { tokens, components, designMdChanged, count };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line telling what a diffusion changed, stored with it. */
export function diffusionSummary(diff: DiffusionDiff): string {
  if (diff.count === 0) return "No change";
  const parts: string[] = [];
  for (const [noun, group] of [["token", diff.tokens], ["component", diff.components]] as const) {
    for (const [verb, items] of Object.entries(group)) if (items.length > 0) parts.push(`${plural(items.length, noun)} ${verb}`);
  }
  if (diff.designMdChanged) parts.push("DESIGN.md changed");
  return parts.join(", ");
}

/** A diffusion as listed. */
export interface DiffusionInfo {
  /** 1, 2, ... per design system; never reused. */
  number: number;
  createdAt: string;
  /** `rollback`: projects were sent back to the diffusion `rolledBackTo` (same files, no new snapshot content). */
  origin: "user" | "migration" | "rollback";
  summary: string;
  rolledBackTo?: number;
  /** Undone from the toast or the list: kept, but projects no longer use it. */
  undone: boolean;
}

/** `GET /api/design-systems/:id/diffusions/:n/rollback-impact`: what rolling back to `n` takes away from pages that use it. */
export interface RollbackImpact {
  components: { name: string; usedBy: string[] }[];
}

/** A diffusion as listed by `GET /api/design-systems/:id/diffusions`: with what it changed since the previous one (the first: everything). */
export interface DiffusionListItem extends DiffusionInfo {
  changes: DiffusionDiff;
}

/** A page of a design system on its overview. */
export interface DesignSystemPageInfo {
  id: string;
  title: string;
  componentCount: number;
  /** Names of the page's components, sorted. */
  componentNames: string[];
  /** Components of the page added or changed in the draft and not diffused yet. */
  pendingCount: number;
}

/** A project following a design system, with what it holds of its own. */
export interface DesignSystemUser {
  id: string;
  title: string;
  /** Project-style tokens that redefine a token of the current diffusion. */
  overrideCount: number;
  componentCount: number;
}

/** `GET /api/design-systems/:id`: the design system with its pages, current diffusion and what is pending. */
export interface DesignSystemDetail {
  id: string;
  title: string;
  pageId: string;
  pages: DesignSystemPageInfo[];
  usedBy: DesignSystemUser[];
  /** Components and tokens of the draft. */
  componentCount: number;
  tokenCount: number;
  /** Up to three colours of the draft (primary, text, background first), for page thumbnails. */
  palette: string[];
  current: DiffusionInfo;
  /** Projects of `usedBy` whose own style redefines tokens that the pending changes alter: the change has no effect there. */
  overrides: { id: string; title: string; tokens: string[] }[];
  /** Draft compared with the current diffusion; `count` 0 = nothing pending. */
  pending: DiffusionDiff;
}

/** Path on the artboard origin serving a file of one diffusion (immutable, so cacheable forever). */
export const diffusionFileUrlPath = (designSystemId: string, diffusion: number, file: "tokens.css" | "components.css") =>
  `/design-systems/${encodeURIComponent(designSystemId)}/diffusions/${diffusion}/${file}`;

/**
 * Path on the artboard origin rendering one component alone: with the files of `diffusion` when given (the "before"
 * of a pending change), else with the live draft (the "after").
 */
export const componentPreviewUrlPath = (designSystemId: string, name: string, diffusion?: number) =>
  `/design-systems/${encodeURIComponent(designSystemId)}/component-previews/${encodeURIComponent(name)}${diffusion === undefined ? "" : `?diffusion=${diffusion}`}`;

/** Query on an artboard URL asking for the design system draft instead of the current diffusion (the viewer's preview, nothing stored). */
export const DRAFT_PREVIEW_QUERY = "preview=draft";
