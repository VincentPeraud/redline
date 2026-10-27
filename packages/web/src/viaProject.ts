/**
 * The project a design system's page was opened from (`?projet=` on its address), kept while the person stays on that page,
 * so that moving around the canvas, which rewrites the address, does not lose it. Threads and conversations started there carry it.
 */
let current: { pageId: string; viaProjectId?: string } | undefined;

/**
 * Called with every route (`pageId` undefined off a page): entering a page takes its `?projet=` (or none); staying on it keeps
 * the one it was entered with; leaving it forgets it.
 */
export function notePageRoute(pageId: string | undefined, viaProjectId: string | undefined): void {
  if (pageId === undefined) current = undefined;
  else if (current?.pageId !== pageId) current = { pageId, viaProjectId };
  else if (viaProjectId !== undefined) current.viaProjectId = viaProjectId;
}

/** `{ viaProjectId }` to spread into a thread or conversation request, or nothing. */
export function viaProjectField(pageId: string): { viaProjectId?: string } {
  return current?.pageId === pageId && current.viaProjectId !== undefined ? { viaProjectId: current.viaProjectId } : {};
}
