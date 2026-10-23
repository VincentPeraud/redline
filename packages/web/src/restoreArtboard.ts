import { useCallback, useEffect, useState } from "react";
import type { DeletedArtboard, RestoreArtboardRequest, RestoreArtboardResponse } from "@redline/shared";

/** Puts one artboard back to its state in page version `versionId` (also the undo: pass the previous version id). */
export async function restoreArtboard(pageId: string, file: string, versionId: string): Promise<RestoreArtboardResponse> {
  const request: RestoreArtboardRequest = { file, versionId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const res = await fetch(`/api/pages/${pageId}/artboards/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`Restore refused (${res.status})`);
  return (await res.json()) as RestoreArtboardResponse;
}

/** Artboards removed from the page, refetched whenever the page's version changes. */
export function useDeletedArtboards(pageId: string, versionId: string): DeletedArtboard[] {
  const [deleted, setDeleted] = useState<DeletedArtboard[]>([]);
  const load = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/deleted-artboards`);
    setDeleted((await res.json()) as DeletedArtboard[]);
  }, [pageId]);
  useEffect(() => {
    void load();
  }, [load, versionId]);
  return deleted;
}
