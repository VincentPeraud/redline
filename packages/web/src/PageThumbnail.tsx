import { useEffect, useRef, useState } from "react";
import { MANIFEST_PATH, defaultManifest, parseManifest, type ManifestArtboard } from "@redline/shared";
import { cx } from "./ui/index.js";
import styles from "./PageThumbnail.module.css";

const MAX_ARTBOARDS = 3;
const DEFAULT_AREA_HEIGHT = 150;
const DEFAULT_AREA_PADDING = 16;
const ARTBOARD_GAP = 12;

/** Artboards of a page, read from its manifest (or the default one when the page has none). */
export function usePageArtboards(pageId: string, files: Record<string, string>): ManifestArtboard[] | null {
  const [artboards, setArtboards] = useState<ManifestArtboard[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const manifest =
        MANIFEST_PATH in files
          ? parseManifest(await (await fetch(`/api/pages/${pageId}/files/${MANIFEST_PATH}`)).text())
          : defaultManifest(Object.keys(files));
      if (!cancelled) setArtboards(manifest.artboards);
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId, files]);

  return artboards;
}

/** First artboards of the page, rendered live and scaled to fit the card's preview area. */
export function PageThumbnail({
  pageId,
  artboards,
  artboardOrigin,
  areaHeight = DEFAULT_AREA_HEIGHT,
  areaPadding = DEFAULT_AREA_PADDING,
  className,
}: {
  pageId: string;
  artboards: ManifestArtboard[] | null;
  artboardOrigin: string;
  areaHeight?: number;
  areaPadding?: number;
  className?: string;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(0);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => setAreaWidth(entry!.contentRect.width));
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const shown = (artboards ?? []).slice(0, MAX_ARTBOARDS);
  const totalWidth = shown.reduce((sum, artboard) => sum + artboard.width, 0);
  const maxHeight = Math.max(0, ...shown.map((artboard) => artboard.height));
  const availableWidth = areaWidth - 2 * areaPadding - ARTBOARD_GAP * (shown.length - 1);
  const scale =
    shown.length === 0 || areaWidth === 0
      ? 1
      : Math.min((areaHeight - 2 * areaPadding) / maxHeight, availableWidth / totalWidth, 1);

  return (
    <div ref={areaRef} className={cx(styles.area, className)} style={{ height: areaHeight }} aria-hidden="true">
      {artboardOrigin &&
        areaWidth > 0 &&
        shown.map((artboard) => (
          <div
            key={artboard.file}
            className={styles.frame}
            style={{ width: artboard.width * scale, height: artboard.height * scale }}
          >
            <iframe
              sandbox="allow-scripts"
              tabIndex={-1}
              title={`Aperçu de ${artboard.file}`}
              src={`${artboardOrigin}/pages/${pageId}/${artboard.file}`}
              className={styles.iframe}
              style={{ width: artboard.width, height: artboard.height, transform: `scale(${scale})` }}
            />
          </div>
        ))}
    </div>
  );
}
