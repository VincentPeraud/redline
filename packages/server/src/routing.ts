import type { Thread } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

/**
 * Where new work on an open thread goes: "agent" (queued under the agent routing rule), "account" (it waits for the account that took
 * the thread: nothing is queued, a conversation of that account finds it with `pending_comments`), or "take" (nobody handles it yet).
 *
 * The single routing rule, in this order (drafts and "À relire" threads never get here: they stay with their author or their readers):
 * a thread an agent owns (a session, or work queued, running or failed) -> the agent; a thread an account took -> that account;
 * a page in Agent mode -> the agent; a page in Conversation mode -> to take.
 * Free-form page conversations do not go through here: they always go to the agent.
 */
export type Route = "agent" | "account" | "take";

export function routeOf(store: Store, pageLock: PageLock, thread: Pick<Thread, "id" | "pageId">): Route {
  if (store.getThreadSession(thread.id) || pageLock.hasWorkFor(thread.id)) return "agent";
  if (store.takeOf(thread.id)) return "account";
  return store.effectiveCommentMode(thread.pageId) === "agent" ? "agent" : "take";
}

/** The threads among `threads` whose new work goes to the agent. */
export const goingToAgent = (store: Store, pageLock: PageLock, threads: Thread[]): Thread[] => threads.filter((thread) => routeOf(store, pageLock, thread) === "agent");
