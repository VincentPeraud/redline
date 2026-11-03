// The diffusion review (instances lot, ticket 12): everything changed since the current diffusion, as the Diffuse dialog lists it.

/** Where a change comes from: a request of a project, the user's own comment, or work done straight in the design system. */
export type ReviewOrigin = { kind: "direct" } | { kind: "request" | "comment"; from: string[] };

/** One token that differs between the draft and the current diffusion. */
export interface ReviewToken {
  name: string;
  kind: "changed" | "added" | "removed";
  /** The value before (changed, removed). */
  from?: string;
  /** The value after (changed, added). */
  to?: string;
}

/** One line of a card's "Ce qui change". */
export interface ReviewChange {
  /** Empty for an `undescribed` line. */
  label: string;
  /** A component that changed with no recorded change and no default change: the web words the line ("Modification sans description"). */
  undescribed?: true;
  origin: ReviewOrigin;
  /** The recorded change this line shows; absent for a derived line ("Modification sans description", a default value). */
  changeId?: string;
  /** Born of a request and not refused yet, so it can be refused from the review. */
  refusable: boolean;
  /** Refused, and the design system's session has not undone it in the draft yet ("annulation en cours"). */
  undoing: boolean;
}

/** A page of a following project that writes instances of a component. */
export interface ReviewPage {
  projectTitle: string;
  pageId: string;
  pageTitle: string;
  instances: number;
}

/** "Où ça change" of a component card. */
export interface ReviewWhere {
  instances: number;
  pages: ReviewPage[];
  /** Titles of the projects that keep their own component of that name (left out of the count). */
  keptBy: string[];
  /** Projects that moved this component up ("Remonter"), with the instances they write: those pass to the design system's one. */
  movedUp: { project: string; instances: number }[];
}

export interface ReviewComponent {
  /** Without the `ui-` prefix. */
  name: string;
  kind: "added" | "changed" | "removed";
  changes: ReviewChange[];
  where: ReviewWhere;
}

/** `GET /api/design-systems/:id/review`. */
export interface DiffusionReview {
  tokens: ReviewToken[];
  designMdChanged: boolean;
  /** Titles of the projects following the design system ("Toutes les pages de ..."). */
  projects: string[];
  components: ReviewComponent[];
  /** Refused changes not undone yet: "Diffuser" is unavailable while there is one. */
  undoing: number;
}

/** The change line shown when a default value changed: "Valeur par défaut de size : md → lg". */
export const defaultChangeLabel = (setting: string, from: string | number | boolean | undefined, to: string | number | boolean | undefined) =>
  `Valeur par défaut de ${setting} : ${String(from)} → ${String(to)}`;
