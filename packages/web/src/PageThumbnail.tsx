import { useEffect, useState } from "react";
import { MANIFEST_PATH, defaultManifest, parseManifest } from "@redline/shared";

const THUMB_WIDTH = 240;

/** First artboard of the page, rendered live and scaled down. */
export function PageThumbnail({
  pageId,
  files,
  artboardOrigin,
}: {
  pageId: string;
  files: Record<string, string>;
  artboardOrigin: string;
}) {
  const [artboard, setArtboard] = useState<{ file: string; width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const manifest =
        MANIFEST_PATH in files
          ? parseManifest(await (await fetch(`/api/pages/${pageId}/files/${MANIFEST_PATH}`)).text())
          : defaultManifest(Object.keys(files));
      if (!cancelled) setArtboard(manifest.artboards[0] ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId, files]);

  const scale = artboard ? THUMB_WIDTH / artboard.width : 1;
  return (
    <div
      style={{
        width: THUMB_WIDTH,
        height: artboard ? artboard.height * scale : 150,
        overflow: "hidden",
        background: "#f4f3ef",
        border: "1px solid #d4d2cc",
      }}
    >
      {artboard && artboardOrigin && (
        <iframe
          sandbox="allow-scripts"
          tabIndex={-1}
          title={`Aperçu de ${artboard.file}`}
          src={`${artboardOrigin}/pages/${pageId}/${artboard.file}`}
          style={{
            width: artboard.width,
            height: artboard.height,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
