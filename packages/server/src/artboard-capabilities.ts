import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessLevel, ArtboardCapability } from "@redline/shared";
import type { Access, Viewer } from "./access.js";

export const CAPABILITY_LIFETIME_MS = 10 * 60_000;
const KEY_FILE = "artboard-capability.key";

/** The signing key lives in the data folder, created once, so capabilities survive a restart. */
export function loadCapabilityKey(dataDir: string): Buffer {
  const path = join(dataDir, KEY_FILE);
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export interface CapabilityScope {
  projectId: string;
  /** Limited to this page (a page link). */
  pageId?: string;
  /** Issued to a link visitor at this level: Lecture and Commentaire see the latest version only, never the history. */
  linkLevel?: AccessLevel;
  /** Issued to a project link: its pages do not include the archived ones. */
  withoutArchived?: true;
}

/** Short-lived signed passes to the artboard origin, each for the files of one project (its design system's included). */
export class ArtboardCapabilities {
  constructor(
    private readonly key: Buffer,
    readonly lifetimeMs: number = CAPABILITY_LIFETIME_MS,
  ) {}

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  /** Issues a capability for `projectId` to a viewer the access module lets read it; undefined otherwise. A page-link visitor's is limited to its page. */
  issueFor(access: Access, viewer: Viewer, projectId: string): ArtboardCapability | undefined {
    if (!access.may(viewer, "read", { projectId })) return undefined;
    if (viewer.kind !== "link") return this.issue(projectId);
    const { scope, scopeId, level } = viewer.link;
    return this.issue(projectId, scope === "page" ? scopeId : undefined, { linkLevel: level, ...(scope === "project" ? { withoutArchived: true } : {}) });
  }

  issue(projectId: string, pageId?: string, limits: { linkLevel?: AccessLevel; withoutArchived?: boolean } = {}): ArtboardCapability {
    const payload = Buffer.from(
      JSON.stringify({ p: projectId, e: Date.now() + this.lifetimeMs, ...(pageId === undefined ? {} : { g: pageId }), ...(limits.linkLevel === undefined ? {} : { l: limits.linkLevel }), ...(limits.withoutArchived ? { a: 1 } : {}) }),
    ).toString("base64url");
    return { capability: `${payload}.${this.sign(payload)}`, lifetimeMs: this.lifetimeMs, renewAfterMs: this.lifetimeMs / 2 };
  }

  /** The project a capability is for, with its limits (one page; the level of the link it was issued to; no archived pages), or undefined when it is forged, damaged or expired. */
  scopeOf(capability: string): CapabilityScope | undefined {
    const [payload, signature, extra] = capability.split(".");
    if (!payload || !signature || extra !== undefined) return undefined;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const { p, e, g, l, a } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { p: string; e: number; g?: string; l?: AccessLevel; a?: number };
      return typeof p === "string" && e > Date.now() ? { projectId: p, ...(g === undefined ? {} : { pageId: g }), ...(l === undefined ? {} : { linkLevel: l }), ...(a === 1 ? { withoutArchived: true } : {}) } : undefined;
    } catch {
      return undefined;
    }
  }
}
