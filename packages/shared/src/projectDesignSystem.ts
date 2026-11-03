// A project's "Design system" page and overview box (lot E, ticket 15): the shared design system it follows, the
// tokens with their design system and project values, and the project components.

import type { DesignMdAuthor } from "./projectFiles.js";
import type { DiffusionInfo } from "./diffusion.js";

export interface ProjectStyleToken {
  name: string;
  /** Value in the design system's current diffusion; null when the project has none or does not know the token. */
  designSystemValue: string | null;
  /** Value written in the project style; null when the project does not set the token. */
  projectValue: string | null;
  /** What applies to the project: the project value, else the design system's. */
  value: string;
  isColor: boolean;
  /** One of the core tokens every design system defines. */
  core: boolean;
  deprecatedFor?: string;
  /**
   * `overridden`: set by the project and known to the diffusion. `inherited`: follows the design system.
   * `new`: only in the project style, next to a shared design system. `own`: a project without a shared design system.
   */
  status: "overridden" | "inherited" | "new" | "own";
}

export interface ProjectComponentInfo {
  name: string;
  file: string;
  page: { id: string; title: string };
  /** Instances of the component (`<ui-name>`) in the project's pages. */
  instances: number;
  /** Pages of the project with at least one instance. */
  pages: number;
  /** The project's design system has a component of the same name (the project's own keeps winning in its pages). */
  inDesignSystem: boolean;
}

/** A design system component the project left out at a switch: its instances stay broken until the user takes it. */
export interface ExcludedComponent {
  name: string;
  tag: string;
  /** Title of the design system it was not taken from. */
  from: string;
  /** The project's current design system has a component of that name, so it can be taken. */
  available: boolean;
}

/** `GET /api/projects/:id/design-system`. */
export interface ProjectDesignSystem {
  /** The shared design system the project follows; null = "Aucun : style propre au projet". */
  designSystem: { id: string; title: string } | null;
  /** Its current diffusion; null without a shared design system. */
  diffusion: DiffusionInfo | null;
  tokens: ProjectStyleToken[];
  /** True when the project style itself declares at least one token (`styleDefinesTokens`). */
  styleDefinesTokens: boolean;
  components: ProjectComponentInfo[];
  /** Design system components left out at the last switch. */
  excluded: ExcludedComponent[];
  /** Project-style tokens whose names exist in the current diffusion. */
  overrideCount: number;
  /** Last change of the project style. */
  lastModified: (DesignMdAuthor & { createdAt: string }) | null;
}

/** `PUT /api/projects/:id/project-style/tokens/:name`. */
export interface SetProjectTokenRequest {
  value: string;
}

/** `PUT /api/projects/:id/design-system`: a shared design system id, or null for "Aucun : style propre au projet". */
export interface SetProjectDesignSystemRequest {
  designSystem: string | null;
  /**
   * Tags (`ui-name`) of the used components that take the new design system's version. Absent ones cannot be taken;
   * every other used component is left out. Omitted: the pre-ticked ones (same name, same settings and slots).
   */
  ticked?: string[];
}

/** How a used component compares with the target design system's current diffusion. */
export type SwitchMatch = "same" | "different" | "absent";

export interface SwitchComponent {
  name: string;
  tag: string;
  instances: number;
  pages: number;
  /** Title of the page when only one page uses it. */
  page: string;
  match: SwitchMatch;
  /** The match pill: "même nom, mêmes réglages", "même nom, variante pills absente", "absent de <design system>". */
  label: string;
}

/** `GET /api/projects/:id/design-system/switch?to=<design system id>`: what the switch dialog shows. */
export interface DesignSystemSwitchPreview {
  from: { id: string; title: string } | null;
  to: { id: string; title: string };
  /** Design system components the project's pages use. */
  components: SwitchComponent[];
  /** Tags of the project's own components, which a switch leaves alone. */
  own: string[];
}

/** `POST /api/projects/:id/design-system/promote`: makes the project's own style a shared design system (201 `DesignSystem`). */
export interface PromoteProjectStyleRequest {
  title: string;
}
