/**
 * The project a design system's page was opened from (`?projet=` on its address), kept for the tab's lifetime so that
 * moving around the canvas, which rewrites the address, does not lose it. Threads and conversations started there carry it.
 */
const viaByPage = new Map<string, string>();

export function rememberViaProject(pageId: string, viaProjectId: string | undefined): void {
  if (viaProjectId !== undefined) viaByPage.set(pageId, viaProjectId);
}

/** `{ viaProjectId }` to spread into a thread or conversation request, or nothing. */
export function viaProjectField(pageId: string): { viaProjectId?: string } {
  const viaProjectId = viaByPage.get(pageId);
  return viaProjectId === undefined ? {} : { viaProjectId };
}
