import { MANIFEST_PATH, parseManifest, requestComponentName, type SendRequestRequest, type SendRequestResponse } from "@redline/shared";
import { projectComponents } from "./components.js";
import { modelChoiceOf, requiredString } from "./validation.js";
import type { PageLock } from "./page-lock.js";
import type { Store, StoredRequest } from "./store.js";
import { dispatchThread, type TerminalPresence } from "./work.js";

export type SendRequestOutcome = { status: 201; body: SendRequestResponse } | { status: 400 | 404 | 409; body: { error: string } };

const mainPageArtboard = (store: Store, pageId: string): string | undefined => {
  const manifest = store.readPageFile(pageId, MANIFEST_PATH)?.toString("utf8");
  return manifest === undefined ? undefined : parseManifest(manifest).artboards[0]?.file;
};

/**
 * A project's session asks the design system it follows for something a component lacks: a thread on the component's
 * artboard in the design system, sent to the design system's work like any thread (no accept step).
 */
export function sendRequest(store: Store, pageLock: PageLock, terminal: TerminalPresence, pageId: string, body: Partial<SendRequestRequest> | undefined): SendRequestOutcome {
  const page = store.getPage(pageId);
  if (!page) return { status: 404, body: { error: "page not found" } };
  const { component, missing, artboard, selector, threadId } = body ?? {};
  if (!requiredString(component) || !requiredString(missing) || !requiredString(artboard)) return { status: 400, body: { error: "component, missing and artboard are required" } };
  if (selector !== undefined && typeof selector !== "string") return { status: 400, body: { error: "selector must be a string" } };
  if (!store.hasArtboard(pageId, artboard)) return { status: 400, body: { error: "artboard is not on the page" } };
  const origin = threadId === undefined ? undefined : store.getThread(threadId);
  if (threadId !== undefined && origin?.pageId !== pageId) return { status: 400, body: { error: "threadId is not a thread of this page" } };

  const designSystemId = store.getProject(page.projectId)?.designSystem;
  const designSystem = designSystemId ? store.getDesignSystem(designSystemId) : undefined;
  if (!designSystem || store.isDesignSystemProject(page.projectId)) return { status: 409, body: { error: "This project does not follow a design system, so there is nothing to ask. Make the change in the mock-up, or create a project component." } };
  if (designSystem.archivedAt) return { status: 409, body: { error: "The design system is archived: it cannot receive requests." } };

  const name = requestComponentName(component);
  const info = projectComponents(store, designSystem.id).components.find((candidate) => candidate.name === name);

  const request: StoredRequest = {
    kind: "component",
    state: "in_progress",
    component: name,
    ...(origin ? { detail: missing.trim() } : {}),
    origins: [{ projectId: page.projectId, pageId, artboard, ...(selector ? { selector } : {}), ...(origin ? { threadId: origin.id } : {}) }],
  };
  // The words are the user's when Claude routed their comment: the thread keeps their text and their name.
  // A component the design system lacks has no artboard: the request sits on the first artboard of its main page.
  const anchor = info ?? { page: { id: designSystem.pageId }, file: mainPageArtboard(store, designSystem.pageId) ?? `components/${name}.html` };
  const thread = store.createThread(anchor.page.id, { target: { kind: "artboard", artboard: anchor.file }, body: origin?.body ?? missing.trim(), viaProjectId: page.projectId }, origin?.person, false, request);
  dispatchThread(pageLock, designSystem.id, thread, modelChoiceOf({}), terminal);
  return { status: 201, body: { threadId: thread.id, pageId: thread.pageId, designSystemTitle: designSystem.title } };
}
