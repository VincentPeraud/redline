// Change records (instances lot, ticket 11): what the design system's session says it changed, per component, when it publishes.

export const CHANGE_KINDS = ["added", "removed", "modified"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** `pending` until the next diffusion; `refused` by the user (until the draft is undone); `diffused` once frozen in a diffusion. */
export type ChangeState = "pending" | "refused" | "diffused";

/** The element a change touches: a selector in the artboard of the draft, of the current diffusion, or both (a modified element). */
export interface ChangeAnchor {
  draft?: string;
  diffused?: string;
}

/** One change as the session records it. */
export interface ChangeRecordInput {
  /** The component, as `ui-modal` or `modal`. */
  component: string;
  /** A short label, e.g. "Taille 720 px". */
  label: string;
  kind: ChangeKind;
  /** The request thread (or any thread of the design system) this change answers. */
  threadId?: string;
  anchor?: ChangeAnchor;
}

export interface ChangeRecord {
  id: string;
  designSystemId: string;
  /** Component name without the `ui-` prefix. */
  component: string;
  label: string;
  kind: ChangeKind;
  state: ChangeState;
  threadId?: string;
  anchor?: ChangeAnchor;
  /** The design system page version that published it. */
  versionId: string;
  createdAt: string;
}

/** Body of `POST /agent-api/requests/:threadId/merge`: the design system's session attaches a request to an existing one. */
export interface MergeRequestRequest {
  /** The request that stays open. */
  into: string;
  workId?: string;
}
