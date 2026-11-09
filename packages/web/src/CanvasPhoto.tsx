import { ArtboardIframe } from "./artboardCapability.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { renderingSlots, responsiveFrameLayout, tweakGrid, tweakGridLayout, type Manifest, type ManifestElement } from "@redline/shared";
import { CanvasElements } from "./CanvasElements.js";
import { photoFit, type PhotoFit } from "./canvasPhotoFit.js";
import type { Box } from "./canvasGeometry.js";
import { cx } from "./ui/index.js";
export { usePageManifest } from "./usePageManifest.js";
import styles from "./CanvasPhoto.module.css";

/**
 * An artboard as the photo draws it: its frame, and where its page shows inside (one place per rendering; none for a tweak grid).
 * `src` is the page the canvas shows (a draft or an old version included); `version` changes when that page does, to reload it.
 */
export interface PhotoArtboard {
  file: string;
  src: string;
  version: string;
  frame: Box;
  shots: Box[];
}

type ManifestArtboard = Manifest["artboards"][number];

/** Under this width on screen, an artboard is drawn as a plain frame: its page would not be readable and costs an iframe. */
const MIN_SHOT_WIDTH = 24;

/**
 * The artboards of a manifest as the photo draws them. The canvas passes its own layout (real heights of the pages);
 * a card has only the manifest, so it uses the declared sizes.
 */
export function photoArtboards(
  artboards: readonly ManifestArtboard[],
  tweaks: Manifest["tweaks"],
  source: (file: string) => { src: string; version: string },
  layout: { heightOf?: (artboard: ManifestArtboard) => number; responsiveOf?: (artboard: ManifestArtboard) => ReturnType<typeof responsiveFrameLayout> | null } = {},
): PhotoArtboard[] {
  return artboards.map((artboard) => {
    const base = { file: artboard.file, ...source(artboard.file) };
    if (artboard.responsive) {
      const { frame, renderings } = layout.responsiveOf?.(artboard) ?? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive));
      return { ...base, frame, shots: renderings };
    }
    if (artboard.matrix) {
      const grid = tweakGridLayout(tweakGrid(artboard.matrix, tweaks ?? []), artboard);
      return { ...base, frame: { x: artboard.x, y: artboard.y, width: grid.width, height: grid.height }, shots: [] };
    }
    const frame = { x: artboard.x, y: artboard.y, width: artboard.width, height: layout.heightOf?.(artboard) ?? artboard.height };
    return { ...base, frame, shots: [frame] };
  });
}

const NO_THREADS: never[] = [];

/** A photo is a picture: the link cards in it take no focus and no click (React's types lack `inert`). */
const keepOutOfReach = (node: HTMLDivElement | null) => node?.setAttribute("inert", "");

/**
 * A read-only picture of the whole canvas of a page, scaled to its area: the real artboards, images, titles, notes,
 * shapes and arrows. A card crops a very tall canvas to its top (`crop`); `overlay` draws over it, given where the canvas sits.
 */
export function CanvasPhoto({
  pageId,
  artboardOrigin,
  artboards,
  elements,
  height,
  padding = 16,
  crop = false,
  className,
  overlay,
}: {
  pageId: string;
  artboardOrigin: string;
  artboards: PhotoArtboard[];
  elements: ManifestElement[];
  /** The area's height, or how to get it from the box the canvas content takes. */
  height: number | ((bounds: Box) => number);
  padding?: number;
  crop?: boolean;
  className?: string;
  overlay?: (fit: PhotoFit) => ReactNode;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(0);
  const [bounds, setBounds] = useState<Box | null>(null);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => setAreaWidth(entry!.contentRect.width));
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const artboardBoxes = useMemo(() => new Map(artboards.map((artboard) => [artboard.file, artboard.frame])), [artboards]);
  const areaHeight = typeof height === "number" ? height : bounds ? height(bounds) : 0;
  const fit = bounds && areaWidth > 0 ? photoFit(bounds, { width: areaWidth, height: areaHeight }, padding, { crop }) : null;
  const empty = artboards.length === 0 && elements.length === 0;

  return (
    <div ref={areaRef} className={cx(styles.area, className)} style={{ height: areaHeight }}>
      {artboardOrigin && !empty && (
        <div
          aria-hidden="true"
          ref={keepOutOfReach}
          className={styles.world}
          style={{
            transform: fit ? `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` : undefined,
            visibility: fit ? "visible" : "hidden",
            ["--unit" as string]: 1 / (fit?.scale ?? 1),
          }}
        >
          <CanvasElements
            elements={elements}
            artboardBoxes={artboardBoxes}
            assetBase={`${artboardOrigin}/pages/${pageId}`}
            artboardOrigin={artboardOrigin}
            picking={false}
            zoom={1}
            liftTitles={false}
            threads={NO_THREADS}
            marks={NO_THREADS}
            onContentBounds={setBounds}
          >
            {artboards.map(({ file, src, version, frame, shots }) => (
              <div key={file} data-photo-artboard={file} className={styles.artboard} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
                {fit &&
                  shots.map((shot, i) =>
                    shot.width * fit.scale < MIN_SHOT_WIDTH ? (
                      <div key={i} className={styles.blank} style={{ left: shot.x - frame.x, top: shot.y - frame.y, width: shot.width, height: shot.height }} />
                    ) : (
                      <ArtboardIframe
                        key={`${i}@${version}`}
                        sandbox="allow-scripts"
                        loading="lazy"
                        tabIndex={-1}
                        title={`Aperçu de ${file}`}
                        src={src}
                        className={styles.shot}
                        style={{ left: shot.x - frame.x, top: shot.y - frame.y, width: shot.width, height: shot.height }}
                      />
                    ),
                  )}
              </div>
            ))}
          </CanvasElements>
        </div>
      )}
      {fit && overlay?.(fit)}
    </div>
  );
}

/** A page's canvas photo for a card, cropped to its top when the canvas is very tall. */
export function PageCanvasPhoto({
  pageId,
  files,
  manifest,
  artboardOrigin,
  height,
  className,
}: {
  pageId: string;
  files: Record<string, string>;
  manifest: Manifest | null;
  artboardOrigin: string;
  height: number;
  className?: string;
}) {
  const source = (file: string) => ({ src: `${artboardOrigin}/pages/${pageId}/${file}`, version: files[file] ?? "" });
  return (
    <CanvasPhoto
      pageId={pageId}
      artboardOrigin={manifest ? artboardOrigin : ""}
      artboards={manifest ? photoArtboards(manifest.artboards, manifest.tweaks, source) : []}
      elements={manifest?.elements ?? []}
      height={height}
      crop
      className={className}
    />
  );
}
