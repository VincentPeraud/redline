import { INSTANCE_TAG_PREFIX } from "./componentDefinition.js";

/**
 * Anchor of a thread on an element shown inside a component instance: "<selector of the instance> >>> <path within what
 * it renders>", e.g. "main > ui-modal#confirm >>> div > footer > button:nth-of-type(2)". The artboard bridge builds and
 * resolves it; everything else only reads it through the helpers below.
 */
export const INSTANCE_ANCHOR_SEPARATOR = " >>> ";

/** The instance tag ("ui-modal") a thread selector points inside, or null when the element is not inside an instance. */
export function instanceTagOfAnchor(selector: string): string | null {
  const at = selector.indexOf(INSTANCE_ANCHOR_SEPARATOR);
  if (at === -1) return null;
  const last = selector.slice(0, at).split(/\s*>\s*/).pop() ?? "";
  const match = new RegExp(`^(${INSTANCE_TAG_PREFIX}[a-z0-9-]+)(?:[#:]|$)`, "i").exec(last);
  return match ? match[1]!.toLowerCase() : null;
}
