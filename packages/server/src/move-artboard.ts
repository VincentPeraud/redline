import { isSafePath, type MoveArtboardRequest, type MoveArtboardResponse, type VersionOrigin } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { OriginRef, Store } from "./store.js";
import { requiredString, titleError } from "./validation.js";

export type MoveOutcome = { status: 200; body: MoveArtboardResponse } | { status: 400 | 404 | 409; body: { error: string } };

const refuse = (status: 400 | 404 | 409, error: string): MoveOutcome => ({ status, body: { error } });

/**
 * Checks a move request and performs it. Pages held by a work item other than `exceptWorkId` (the run asking for the
 * move may hold its own page) refuse the move rather than make the caller wait.
 */
export function moveArtboard(
  store: Store,
  pageLock: PageLock,
  sourceId: string,
  request: Partial<MoveArtboardRequest> | undefined,
  version: { origin: VersionOrigin; ref?: OriginRef; exceptWorkId?: string },
): MoveOutcome {
  const source = store.getPage(sourceId);
  if (!source) return refuse(404, "page not found");
  const { file } = request ?? {};
  if (typeof file !== "string" || !isSafePath(file)) return refuse(400, "file is required");
  if (!store.hasArtboard(sourceId, file)) return refuse(404, `${file} is not an artboard of "${source.title}"`);

  const given = request as { targetPageId?: unknown; newPageTitle?: unknown };
  let target: { pageId: string } | { newPageTitle: string };
  if (given.targetPageId !== undefined) {
    if (!requiredString(given.targetPageId)) return refuse(400, "targetPageId must be a page id");
    const page = store.getPage(given.targetPageId);
    if (!page) return refuse(404, "target page not found");
    if (page.id === sourceId) return refuse(400, "the artboard already is on that page");
    if (page.projectId !== source.projectId) return refuse(400, "an artboard can only move to a page of the same project");
    if (page.version.files[file] !== undefined) return refuse(409, `"${page.title}" already has a file named ${file}`);
    if (pageLock.isHeldByOther(page.id, version.exceptWorkId)) return refuse(409, `A session is working on "${page.title}": try again once it is done.`);
    target = { pageId: page.id };
  } else {
    const invalid = titleError(given.newPageTitle);
    if (invalid) return refuse(400, invalid);
    target = { newPageTitle: (given.newPageTitle as string).trim() };
  }
  if (pageLock.isHeldByOther(sourceId, version.exceptWorkId)) return refuse(409, `A session is working on "${source.title}": try again once it is done.`);

  return { status: 200, body: store.moveArtboard(sourceId, file, target, version.origin, version.ref) };
}
