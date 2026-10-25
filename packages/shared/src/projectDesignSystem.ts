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
  /** `override`: the current diffusion has a component of that name. */
  status: "new" | "override";
}

/** `GET /api/projects/:id/design-system`. */
export interface ProjectDesignSystem {
  /** The shared design system the project follows; null = "Aucun : style propre au projet". */
  designSystem: { id: string; title: string } | null;
  /** Its current diffusion; null without a shared design system. */
  diffusion: DiffusionInfo | null;
  tokens: ProjectStyleToken[];
  components: ProjectComponentInfo[];
  /** Project-style tokens whose names exist in the current diffusion. */
  overrideCount: number;
  /** Last change of the project style. */
  lastModified: (DesignMdAuthor & { createdAt: string }) | null;
}

/** `PUT /api/projects/:id/project-style/tokens/:name`. */
export interface SetProjectTokenRequest {
  value: string;
}
