import { useEffect, useState } from "react";
import { MANIFEST_PATH, defaultManifest, parseManifest, type Manifest } from "@redline/shared";

/** The manifest of a page, read from its files (or the default one when the page has none); null while it loads. */
export function usePageManifest(pageId: string, files: Record<string, string>): Manifest | null {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Another page's artboards must not be drawn under this page's id while its manifest loads.
    setManifest((current) => (current === null ? current : null));
    (async () => {
      const next =
        MANIFEST_PATH in files
          ? parseManifest(await (await fetch(`/api/pages/${pageId}/files/${MANIFEST_PATH}`)).text())
          : defaultManifest(Object.keys(files).filter((path) => path.endsWith(".html")));
      if (!cancelled) setManifest(next);
    })().catch(() => {
      // A manifest that cannot be read leaves the photo empty, as a page without content.
    });
    return () => {
      cancelled = true;
    };
  }, [pageId, files]);
  return manifest;
}
