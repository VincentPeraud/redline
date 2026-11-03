import { requestComponentName, requestIsOpen, type ChangeRecordInput } from "@redline/shared";
import type { Store } from "./store.js";

const KINDS = ["added", "removed", "modified"];
const MAX_LABEL = 120;

/** What is wrong with the changes a design system's session sent with its publish, or null. Checked before anything is published. */
export function changesError(store: Store, pageId: string, changes: unknown): string | null {
  if (changes === undefined) return null;
  if (!store.isDesignSystemPage(pageId)) return "Changes can only be recorded when publishing a design system page.";
  if (!Array.isArray(changes)) return "changes must be a list";
  const designSystemId = store.getPage(pageId)!.projectId;
  const text = (value: unknown) => typeof value === "string" && value.trim() !== "";
  for (const change of changes as Partial<ChangeRecordInput>[]) {
    if (typeof change !== "object" || change === null) return "each change must be an object";
    if (!text(change.component) || !text(change.label)) return "Each change needs a component and a label.";
    if (change.label!.trim().length > MAX_LABEL) return `A change label is ${MAX_LABEL} characters at most.`;
    if (!KINDS.includes(change.kind as string)) return `A change kind is one of ${KINDS.join(", ")}.`;
    if (change.threadId !== undefined) {
      const thread = typeof change.threadId === "string" ? store.getThread(change.threadId) : undefined;
      if (!thread || store.getPage(thread.pageId)?.projectId !== designSystemId) return `Thread ${String(change.threadId)} is not a thread of this design system.`;
    }
    const anchor = change.anchor;
    if (anchor !== undefined && (typeof anchor !== "object" || anchor === null || [anchor.draft, anchor.diffused].some((side) => side !== undefined && !text(side)))) return "A change anchor is { draft?, diffused? } with selectors.";
  }
  return null;
}

export type MergeOutcome = { status: 200; body: { threadId: string; into: string } } | { status: 400 | 404 | 409; body: { error: string } };

/**
 * The design system's session attaches a request to an existing one: the origins join the kept request ("Aussi demandé par")
 * and the merged one closes, so one open request is left.
 */
export function mergeRequests(store: Store, threadId: string, into: unknown): MergeOutcome {
  if (typeof into !== "string" || into === "") return { status: 400, body: { error: "into is required" } };
  if (into === threadId) return { status: 400, body: { error: "A request cannot be merged into itself." } };
  const merged = store.getThread(threadId);
  const kept = store.getThread(into);
  if (!merged || !kept) return { status: 404, body: { error: "request not found" } };
  if (!merged.request || !kept.request) return { status: 400, body: { error: "Only requests can be merged." } };
  if (store.getPage(merged.pageId)?.projectId !== store.getPage(kept.pageId)?.projectId) return { status: 400, body: { error: "Both requests must belong to the same design system." } };
  if (requestComponentName(merged.request.component) !== requestComponentName(kept.request.component)) return { status: 400, body: { error: "Only requests about the same component can be merged." } };
  if (!requestIsOpen(merged.request) || !requestIsOpen(kept.request)) return { status: 409, body: { error: "A closed request (refused, diffused or merged) cannot be merged." } };
  store.mergeRequest(threadId, into);
  return { status: 200, body: { threadId, into } };
}
