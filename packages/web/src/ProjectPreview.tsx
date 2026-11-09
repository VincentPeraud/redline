import { useEffect, useState } from "react";
import type { Page } from "@redline/shared";
import { useArtboardOrigin } from "./artboardCapability.js";
import { PageCanvasPhoto, usePageManifest } from "./CanvasPhoto.js";

const NO_FILES: Record<string, string> = {};

/** A project card's preview: the canvas photo of its last changed page, as on the project overview. Empty without pages. */
export function ProjectPreview({ pageId, height }: { pageId: string | undefined; height: number }) {
  const [page, setPage] = useState<Page | null>(null);
  const artboardOrigin = useArtboardOrigin(page?.projectId);

  useEffect(() => {
    if (!pageId) return setPage(null);
    let cancelled = false;
    fetch(`/api/pages/${pageId}`)
      .then((res) => res.json() as Promise<Page>)
      .then((loaded) => {
        if (!cancelled) setPage(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const manifest = usePageManifest(page?.id ?? "", page?.version.files ?? NO_FILES);
  return <PageCanvasPhoto pageId={page?.id ?? ""} files={page?.version.files ?? NO_FILES} manifest={page ? manifest : null} artboardOrigin={artboardOrigin} height={height} />;
}
