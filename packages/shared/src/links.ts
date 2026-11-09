import type { AccessLevel, Person } from "./index.js";

/** What a share link opens: one page or one project (project links come with ticket 13). */
export type LinkScope = "page" | "project";
/** A personal link is for one named person; a generic one is for anyone holding it (Lecture and Commentaire only). */
export type LinkKind = "personal" | "generic";

/** A share link as members see it (token included: a link can be copied again). */
export interface ShareLink {
  id: string;
  /** Secret part of the address: `/s/<token>`. */
  token: string;
  scope: LinkScope;
  scopeId: string;
  kind: LinkKind;
  name: string;
  level: AccessLevel;
  /** Commentaire links only: the comments go to Claude without a review by a member. */
  direct: boolean;
  /** ISO time after which the link stops working; absent means never. */
  expiresAt?: string;
  status: "active" | "disabled";
  createdAt: string;
  createdBy?: Person;
  disabledAt?: string;
  disabledBy?: Person;
  lastOpenedAt?: string;
  /** Devices that opened the link (one random cookie each). */
  deviceCount: number;
  /** Active but past its expiry: shown with the disabled ones, and "Réactiver" does not bring it back. */
  expired: boolean;
  /** Whether the viewer may edit, disable or reactivate it: its author, the creator of the project and the admins. */
  canManage: boolean;
}

/** `POST /api/pages/:pageId/links`. */
export interface CreateLinkRequest {
  kind: LinkKind;
  name: string;
  level: AccessLevel;
  direct?: boolean;
  /** ISO time; omitted or null means never. */
  expiresAt?: string | null;
}

/** `PATCH /api/links/:linkId`: any field may be sent alone. */
export interface UpdateLinkRequest {
  name?: string;
  level?: AccessLevel;
  direct?: boolean;
  expiresAt?: string | null;
}

/** The address prefix of a link: the web app at `/s/<token>`, its API at `/s/<token>/api/...`. */
export const LINK_PATH_PREFIX = "/s";
export const linkPath = (token: string) => `${LINK_PATH_PREFIX}/${encodeURIComponent(token)}`;

/** The `code` of the single answer (404) every dead link gets: unknown, disabled, expired, deleted or archived scope. */
export const LINK_DEAD_CODE = "link-dead";
export interface LinkDeadResponse {
  error: string;
  code: typeof LINK_DEAD_CODE;
}

/** `GET /s/<token>/api/link`: what the visitor view needs, and nothing about who shared it. */
export interface ShareLinkView {
  scope: LinkScope;
  kind: LinkKind;
  level: AccessLevel;
  /** The name of the link (generic links) or of the person (personal ones). */
  name: string;
  page: { id: string; title: string };
  project: { id: string; title: string };
  /** A signed-in member whose own level on the scope is at least the link's: the app sends them to the normal page. */
  memberRedirect: boolean;
}

/** Who wrote a comment or a reply through a share link: the visitor's name (the link's own for a personal link). Shown "Marc (lien)". */
export interface LinkAuthor {
  linkId: string;
  name: string;
}

/** Longest name a generic-link visitor may give. */
export const MAX_VISITOR_NAME_LENGTH = 60;
