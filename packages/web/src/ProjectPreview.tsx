import { useEffect, useState } from "react";
import type { Page } from "@redline/shared";
import { PageThumbnail, usePageArtboards } from "./PageThumbnail.js";

const NO_FILES: Record<string, string> = {};

let artboardOriginRequest: Promise<string> | undefined;

/** The artboard origin, asked once for every card of the screen. */
function useArtboardOrigin(): string {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    let cancelled = false;
    artboardOriginRequest ??= fetch("/api/config")
      .then((res) => res.json() as Promise<{ artboardOrigin: string }>)
      .then((config) => config.artboardOrigin);
    artboardOriginRequest.then((value) => {
      if (!cancelled) setOrigin(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return origin;
}

/** A project card's preview: the first artboards of its last changed page, as on the project overview. Empty without pages. */
export function ProjectPreview({ pageId, height }: { pageId: string | undefined; height: number }) {
  const artboardOrigin = useArtboardOrigin();
  const [page, setPage] = useState<Page | null>(null);

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

  const artboards = usePageArtboards(page?.id ?? "", page?.version.files ?? NO_FILES);
  return <PageThumbnail pageId={page?.id ?? ""} artboards={page ? artboards : []} artboardOrigin={artboardOrigin} areaHeight={height} />;
}
