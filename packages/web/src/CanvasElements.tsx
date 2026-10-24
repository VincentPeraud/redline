import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArrowEnd, ManifestArrowElement, ManifestArtboard, ManifestElement, ManifestImageElement, ManifestLinkElement, ManifestTitleElement, Page, Project } from "@redline/shared";
import { PageThumbnail, usePageArtboards } from "./PageThumbnail.js";
import { routeHref } from "./router.js";
import { CanvasStickyNote, CanvasTextNote } from "./CanvasNotes.js";
import { arrowGeometry, elementBox, type Box, type Point, type Size } from "./canvasGeometry.js";
import { paletteShades } from "./canvasPalette.js";
import styles from "./CanvasElements.module.css";

const TITLE_SIZE = 32;
const MIN_TITLE_SCALE = 0.5;

/** A title stays on one line: it shrinks down to half its size, then ends with an ellipsis. */
function CanvasTitle({ element }: { element: ManifestTitleElement }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(TITLE_SIZE);
  const [titleCut, setTitleCut] = useState(false);
  const [subtitleCut, setSubtitleCut] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const title = titleRef.current;
      if (title) {
        title.style.fontSize = `${TITLE_SIZE}px`;
        const natural = title.scrollWidth;
        const scale = Math.min(1, Math.max(MIN_TITLE_SCALE, element.width / natural));
        title.style.fontSize = `${TITLE_SIZE * scale}px`;
        setFontSize(TITLE_SIZE * scale);
        setTitleCut(natural * scale > element.width + 0.5);
      }
      const subtitle = subtitleRef.current;
      if (subtitle) setSubtitleCut(subtitle.scrollHeight > subtitle.clientHeight + 1);
    };
    measure();
    void document.fonts.ready.then(measure);
  }, [element.text, element.subtitle, element.width]);

  return (
    <div className={styles.title} style={{ left: element.x, top: element.y, maxWidth: element.width }}>
      <h2 ref={titleRef} data-canvas-title className={styles.titleText} style={{ fontSize }} title={titleCut ? element.text : undefined}>
        {element.text}
      </h2>
      {element.subtitle && (
        <div ref={subtitleRef} data-canvas-subtitle className={styles.subtitleText} title={subtitleCut ? element.subtitle : undefined}>
          {element.subtitle}
        </div>
      )}
    </div>
  );
}

/** The file is served by the artboard origin, like the assets used inside artboards. */
function CanvasImage({ element, assetBase }: { element: ManifestImageElement; assetBase: string }) {
  const src = `${assetBase}/${element.src.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <figure data-canvas-image className={styles.image} style={{ left: element.x, top: element.y, width: element.width }}>
      <img className={styles.imageFile} src={src} alt={element.src} draggable={false} />
      <figcaption className={styles.imageCaption}>{element.src}</figcaption>
    </figure>
  );
}

function GlobeIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

interface LinkedPage {
  page: Page;
  projectTitle: string;
}

/** The target page and its project; null while loading, "missing" when the page does not exist any more. */
function useLinkedPage(pageId: string): LinkedPage | "missing" | null {
  const [linked, setLinked] = useState<LinkedPage | "missing" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pageResponse = await fetch(`/api/pages/${pageId}`);
      if (!pageResponse.ok) {
        if (!cancelled) setLinked("missing");
        return;
      }
      const page = (await pageResponse.json()) as Page;
      const project = (await (await fetch(`/api/projects/${page.projectId}`)).json()) as Project;
      if (!cancelled) setLinked({ page, projectTitle: project.title });
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  return linked;
}

function PageLinkCard({ pageId, x, y, artboardOrigin }: { pageId: string; x: number; y: number; artboardOrigin: string }) {
  const linked = useLinkedPage(pageId);
  const page = linked && linked !== "missing" ? linked.page : null;
  const artboards = usePageArtboards(pageId, page?.version.files ?? {});
  const subtitle = linked === "missing" ? "Page introuvable" : linked ? `Page · ${linked.projectTitle}` : "";

  return (
    <a data-canvas-link className={styles.linkCard} style={{ left: x, top: y }} href={routeHref({ name: "page", pageId })}>
      {page ? (
        <PageThumbnail pageId={pageId} artboards={artboards} artboardOrigin={artboardOrigin} areaHeight={80} areaPadding={10} className={styles.linkThumb} />
      ) : (
        <span className={styles.linkThumb} />
      )}
      <span className={styles.linkText}>
        <span className={styles.linkTitle}>{page?.title ?? ""}</span>
        <span className={styles.linkSubtitle}>{subtitle}</span>
      </span>
      <span aria-hidden="true" className={styles.linkArrow}>→</span>
    </a>
  );
}

function UrlLinkCard({ url, title, x, y }: { url: string; title: string; x: number; y: number }) {
  return (
    <a data-canvas-link className={styles.linkCard} style={{ left: x, top: y }} href={url} target="_blank" rel="noopener noreferrer">
      <span aria-hidden="true" className={styles.linkIcon}>
        <GlobeIcon />
      </span>
      <span className={styles.linkText}>
        <span className={styles.linkTitle}>{title}</span>
        <span className={styles.linkSubtitle}>{new URL(url).hostname}</span>
      </span>
      <span aria-hidden="true" className={styles.linkArrow}>↗</span>
    </a>
  );
}

function CanvasLink({ element, artboardOrigin }: { element: ManifestLinkElement; artboardOrigin: string }) {
  return "page" in element ? (
    <PageLinkCard pageId={element.page} x={element.x} y={element.y} artboardOrigin={artboardOrigin} />
  ) : (
    <UrlLinkCard url={element.url} title={element.title} x={element.x} y={element.y} />
  );
}


/** Add a case here for each new element kind. Arrows are drawn apart, once the boxes they link are known. */
function CanvasElement({ element, assetBase, artboardOrigin }: { element: ManifestElement; assetBase: string; artboardOrigin: string }) {
  switch (element.kind) {
    case "title":
      return <CanvasTitle element={element} />;
    case "link":
      return <CanvasLink element={element} artboardOrigin={artboardOrigin} />;
    case "text":
      return <CanvasTextNote element={element} />;
    case "sticky":
      return <CanvasStickyNote element={element} />;
    case "image":
      return <CanvasImage element={element} assetBase={assetBase} />;
    case "arrow":
      return null;
  }
}

/** Canvas pixels: the board draws at 50 %, so its values are doubled. */
const ARROW_STROKE = 3.2;
const ARROW_DASH = "12 10";

function CanvasArrow({ arrow, boxes }: { arrow: ManifestArrowElement; boxes: Map<string, Box> }) {
  const resolve = (end: ArrowEnd): Box | Point | undefined => (typeof end === "string" ? boxes.get(end) : end);
  const from = resolve(arrow.from);
  const to = resolve(arrow.to);
  if (!from || !to) return null;
  const { start, end, label } = arrowGeometry(from, to);
  const color = paletteShades(arrow.color).stroke;
  return (
    <>
      <svg data-canvas-arrow width="1" height="1" className={styles.arrowLayer} aria-hidden="true">
        <defs>
          <marker id={`redline-tip-${arrow.color}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M1 1l8 4-8 4" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        <path
          d={`M${start.x} ${start.y} L${end.x} ${end.y}`}
          stroke={color}
          strokeWidth={ARROW_STROKE}
          strokeDasharray={arrow.line === "dashed" ? ARROW_DASH : undefined}
          fill="none"
          markerEnd={`url(#redline-tip-${arrow.color})`}
        />
      </svg>
      {arrow.label && (
        <div data-canvas-arrow-label className={styles.arrowLabel} style={{ left: label.x, top: label.y, color }}>
          {arrow.label}
        </div>
      )}
    </>
  );
}

function sameSizes(a: Record<string, Size>, b: Record<string, Size>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] && a[key]!.width === b[key]!.width && a[key]!.height === b[key]!.height);
}

/** Decoration written by Claude: drawn in list order, not draggable, no comment pins. */
export function CanvasElements({ elements, artboards, assetBase, artboardOrigin }: { elements: ManifestElement[]; artboards: ManifestArtboard[]; assetBase: string; artboardOrigin: string }) {
  const placedRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const placed = elements.filter((element) => element.kind !== "arrow");

  // The DOM gives the size of elements that declare no height; the wrapper's children are the placed elements, in order.
  useLayoutEffect(() => {
    const children = Array.from(placedRef.current?.children ?? []) as HTMLElement[];
    const targets = placed.flatMap((element, i) => (element.id !== undefined && children[i] ? [{ id: element.id, node: children[i]! }] : []));
    const measure = () => {
      const next: Record<string, Size> = {};
      for (const { id, node } of targets) next[id] = { width: node.offsetWidth, height: node.offsetHeight };
      setSizes((current) => (sameSizes(current, next) ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const { node } of targets) observer.observe(node);
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, [elements]);

  const boxes = new Map<string, Box>(artboards.map((artboard) => [artboard.file, { x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height }]));
  for (const element of placed) {
    if (element.id === undefined) continue;
    const box = elementBox(element, sizes[element.id]);
    if (box) boxes.set(element.id, box);
  }

  return (
    <>
      <div ref={placedRef} style={{ display: "contents" }}>
        {placed.map((element, i) => (
          <CanvasElement key={i} element={element} assetBase={assetBase} artboardOrigin={artboardOrigin} />
        ))}
      </div>
      {elements.map((element, i) => (element.kind === "arrow" ? <CanvasArrow key={i} arrow={element} boxes={boxes} /> : null))}
    </>
  );
}
