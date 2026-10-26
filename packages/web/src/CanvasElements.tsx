import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { CANVAS_ELEMENT_KIND_LABELS, HOVER_FINISH, MARK_FINISH, placeAnchoredElements, type ArrowEnd, type ManifestArrowElement, type ManifestElement, type ManifestElementKind, type ManifestImageElement, type ManifestLinkElement, type ManifestTitleElement, type Page, type Project, type Thread } from "@redline/shared";
import { PageThumbnail, usePageArtboards } from "./PageThumbnail.js";
import { routeHref } from "./router.js";
import { artboardLabel } from "./elementChips.js";
import { CanvasShape } from "./CanvasShapes.js";
import { CanvasStickyNote, CanvasTextNote } from "./CanvasNotes.js";
import { arrowGeometry, elementBox, type ArrowGeometry, type Box, type Point, type Size } from "./canvasGeometry.js";
import { hoverLabelStyle, hoverOutlineStyle, markBadgeStyle } from "./hoverFinishStyle.js";
import { threadWhere } from "./threadLabel.js";
import { cx } from "./ui/index.js";
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
    <div data-canvas-element-id={element.id} className={styles.title} style={{ left: element.x, top: element.y, maxWidth: element.width }}>
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

/** Height of an artboard's name strip on screen (the tallest, a responsive one's), whatever the zoom: PageCanvas.module.css `.label`. */
const STRIP_HEIGHT = 32;
/** Room kept on screen between a title and the strip under it. */
const STRIP_MARGIN = 8;
/** A title without a measured size: its line and two subtitle lines. */
const TITLE_FALLBACK_HEIGHT = 80;

/**
 * The name strip keeps its screen size, so zoomed out it takes more of the canvas above the artboard: a group title placed
 * just above (y about -120) would slide under it. Such a title goes up exactly as much as needed to stay clear; at 100 % and
 * above nothing moves.
 */
function liftTitlesOverStrips(
  elements: ManifestElement[],
  artboardBoxes: ReadonlyMap<string, Box>,
  sizeOf: (element: ManifestElement) => Size,
  zoom: number,
): ManifestElement[] {
  return elements.map((element) => {
    if (element.kind !== "title") return element;
    const measured = sizeOf(element);
    const width = measured.width || element.width;
    const bottom = element.y + (measured.height || TITLE_FALLBACK_HEIGHT);
    let lift = 0;
    for (const box of artboardBoxes.values()) {
      if (element.x >= box.x + box.width || element.x + width <= box.x || box.y < bottom) continue;
      lift = Math.max(lift, bottom + STRIP_MARGIN / zoom - (box.y - STRIP_HEIGHT / zoom));
    }
    return lift > 0 ? { ...element, y: element.y - lift } : element;
  });
}

/** The file is served by the artboard origin, like the assets used inside artboards. */
function CanvasImage({ element, assetBase }: { element: ManifestImageElement; assetBase: string }) {
  const src = `${assetBase}/${element.src.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <figure data-canvas-image data-canvas-element-id={element.id} className={styles.image} style={{ left: element.x, top: element.y, width: element.width }}>
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

function PageLinkCard({ id, pageId, x, y, artboardOrigin }: { id: string | undefined; pageId: string; x: number; y: number; artboardOrigin: string }) {
  const linked = useLinkedPage(pageId);
  const page = linked && linked !== "missing" ? linked.page : null;
  const artboards = usePageArtboards(pageId, page?.version.files ?? {});
  const subtitle = linked === "missing" ? "Page introuvable" : linked ? `Page · ${linked.projectTitle}` : "";

  return (
    <a data-canvas-link data-canvas-element-id={id} className={styles.linkCard} style={{ left: x, top: y }} href={routeHref({ name: "page", pageId })}>
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

function ArtboardLinkCard({ id, pageId, file, x, y, artboardOrigin }: { id: string | undefined; pageId: string; file: string; x: number; y: number; artboardOrigin: string }) {
  const linked = useLinkedPage(pageId);
  const page = linked && linked !== "missing" ? linked.page : null;
  const artboards = usePageArtboards(pageId, page?.version.files ?? {});
  const artboard = artboards?.find((a) => a.file === file);
  const gone = linked === "missing" || (page !== null && artboards !== null && !artboard);
  const subtitle = linked === "missing" ? "Page introuvable" : gone ? "Artboard introuvable" : linked && artboard ? `Artboard · ${linked.page.title} · ${linked.projectTitle}` : "";

  return (
    <a data-canvas-link data-canvas-element-id={id} className={styles.linkCard} style={{ left: x, top: y }} href={routeHref({ name: "page", pageId, artboard: file })}>
      {artboard ? (
        <PageThumbnail pageId={pageId} artboards={[artboard]} artboardOrigin={artboardOrigin} areaHeight={80} areaPadding={10} className={styles.linkThumb} />
      ) : (
        <span className={styles.linkThumb} />
      )}
      <span className={styles.linkText}>
        <span className={styles.linkTitle}>{artboard ? (artboard.title ?? artboardLabel(file)) : ""}</span>
        <span className={styles.linkSubtitle}>{subtitle}</span>
      </span>
      <span aria-hidden="true" className={styles.linkArrow}>→</span>
    </a>
  );
}

function UrlLinkCard({ id, url, title, x, y }: { id: string | undefined; url: string; title: string; x: number; y: number }) {
  return (
    <a data-canvas-link data-canvas-element-id={id} className={styles.linkCard} style={{ left: x, top: y }} href={url} target="_blank" rel="noopener noreferrer">
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
  if ("page" in element && element.file !== undefined) {
    return <ArtboardLinkCard id={element.id} pageId={element.page} file={element.file} x={element.x} y={element.y} artboardOrigin={artboardOrigin} />;
  }
  return "page" in element ? (
    <PageLinkCard id={element.id} pageId={element.page} x={element.x} y={element.y} artboardOrigin={artboardOrigin} />
  ) : (
    <UrlLinkCard id={element.id} url={element.url} title={element.title} x={element.x} y={element.y} />
  );
}


/** Add a case here for each new element kind. Arrows are drawn apart, once the boxes they link are known. */
function CanvasElement({ element, assetBase, artboardOrigin, commentable }: { element: ManifestElement; assetBase: string; artboardOrigin: string; commentable: boolean }) {
  switch (element.kind) {
    case "title":
      return <CanvasTitle element={element} />;
    case "link":
      return <CanvasLink element={element} artboardOrigin={artboardOrigin} />;
    case "text":
      return <CanvasTextNote element={element} />;
    case "sticky":
      return <CanvasStickyNote element={element} />;
    case "shape":
      return <CanvasShape element={element} hittable={commentable} />;
    case "image":
      return <CanvasImage element={element} assetBase={assetBase} />;
    case "arrow":
      return null;
  }
}

/** Canvas pixels: the board draws at 50 %, so its values are doubled. */
const ARROW_STROKE = 3.2;
const ARROW_DASH = "12 10";

/** Canvas pixels the pointer may be off the line of an arrow and still aim at it. */
const ARROW_HIT_WIDTH = 28;

function CanvasArrow({ arrow, geometry, commentable }: { arrow: ManifestArrowElement; geometry: ArrowGeometry; commentable: boolean }) {
  const { path, label } = geometry;
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
          d={path}
          stroke={color}
          strokeWidth={ARROW_STROKE}
          strokeDasharray={arrow.line === "dashed" ? ARROW_DASH : undefined}
          fill="none"
          markerEnd={`url(#redline-tip-${arrow.color})`}
        />
        {arrow.id !== undefined && (
          <path
            data-canvas-arrow-hit
            data-canvas-element-id={arrow.id}
            d={path}
            stroke="transparent"
            strokeWidth={ARROW_HIT_WIDTH}
            fill="none"
            pointerEvents={commentable ? "stroke" : "none"}
          />
        )}
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

/** Corner radius of the hover outline of each kind, matching the element it surrounds (canvas pixels). */
const OUTLINE_RADIUS: Record<ManifestElementKind, number> = { title: 2, text: 16, sticky: 8, link: 20, image: 6, shape: 20, arrow: 4 };

/** Pins keep their screen size whatever the canvas zoom; board `CommentTargets` sits them 2 px inside the corner. */
const PIN_INSET = 2;

/**
 * Decoration written by Claude, not draggable. In comment mode an element with an id shows the hover outline and
 * label of the artboards (same finish), and carries the pins of its threads. Shapes sit under the artboards
 * (`children`); every other element, arrows included, is drawn above them, in list order.
 */
export function CanvasElements({
  elements: declared,
  artboardBoxes,
  assetBase,
  artboardOrigin,
  picking,
  zoom,
  threads,
  marks,
  children,
}: {
  elements: ManifestElement[];
  artboardBoxes: ReadonlyMap<string, Box>;
  assetBase: string;
  artboardOrigin: string;
  /** Comment mode, selection mode or Alt held: elements with an id can be aimed at and clicked. */
  picking: boolean;
  zoom: number;
  threads: Thread[];
  /** Elements chosen as chips for the next message, drawn with the outline and numbered badge of the artboards' marks. */
  marks: { number: number; elementId: string }[];
  children?: ReactNode;
}) {
  const underRef = useRef<HTMLDivElement>(null);
  const overRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Anchored elements sit against the measured box of their target: a note that grows pushes what hangs below it.
  const elements = useMemo(() => {
    const sizeOf = (element: ManifestElement) => elementBox(element, element.id === undefined ? undefined : sizes[element.id]) ?? { width: 0, height: 0 };
    return liftTitlesOverStrips(placeAnchoredElements(declared, artboardBoxes, sizeOf), artboardBoxes, sizeOf, zoom);
  }, [declared, artboardBoxes, sizes, zoom]);
  const under = elements.filter((element) => element.kind === "shape");
  const over = elements.filter((element) => element.kind !== "shape");

  // The DOM gives the size of elements that declare no height; each wrapper's children are its elements, in order.
  useLayoutEffect(() => {
    const targetsOf = (wrapper: HTMLDivElement | null, list: ManifestElement[]) => {
      const nodes = Array.from(wrapper?.children ?? []) as HTMLElement[];
      return list.flatMap((element, i) => (element.kind !== "arrow" && element.id !== undefined && nodes[i] ? [{ id: element.id, node: nodes[i]! }] : []));
    };
    const targets = [...targetsOf(underRef.current, under), ...targetsOf(overRef.current, over)];
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
  }, [declared]);

  // The element under the mouse, anywhere on the page; leaving comment mode or the window clears it.
  useEffect(() => {
    if (!picking) {
      setHoveredId(null);
      return;
    }
    const onOver = (event: PointerEvent) => setHoveredId((event.target as Element | null)?.closest("[data-canvas-element-id]")?.getAttribute("data-canvas-element-id") ?? null);
    const onOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) setHoveredId(null);
    };
    document.addEventListener("pointermove", onOver);
    document.addEventListener("pointerout", onOut);
    return () => {
      document.removeEventListener("pointermove", onOver);
      document.removeEventListener("pointerout", onOut);
    };
  }, [picking]);

  const boxes = new Map<string, Box>(artboardBoxes);
  for (const element of elements) {
    if (element.kind === "arrow" || element.id === undefined) continue;
    const box = elementBox(element, sizes[element.id]);
    if (box) boxes.set(element.id, box);
  }
  // Arrows: geometry from the boxes they link, then their own box and pin spot.
  const arrowGeometries = new Map<ManifestArrowElement, ArrowGeometry>();
  const resolve = (end: ArrowEnd): Box | Point | undefined => (typeof end === "string" ? boxes.get(end) : end);
  const pinSpots = new Map<string, Point & { inset: boolean }>();
  const outlineBoxes = new Map<string, Box>();
  for (const element of elements) {
    if (element.kind !== "arrow") {
      const box = element.id === undefined ? undefined : boxes.get(element.id);
      if (element.id !== undefined && box && !artboardBoxes.has(element.id)) {
        outlineBoxes.set(element.id, box);
        pinSpots.set(element.id, { x: box.x + box.width, y: box.y, inset: true });
      }
      continue;
    }
    const from = resolve(element.from);
    const to = resolve(element.to);
    if (!from || !to) continue;
    const geometry = arrowGeometry(from, to);
    arrowGeometries.set(element, geometry);
    if (element.id !== undefined) {
      outlineBoxes.set(element.id, geometry.box);
      pinSpots.set(element.id, { ...geometry.label, inset: false });
    }
  }

  const hovered = hoveredId === null ? undefined : elements.find((element) => element.id === hoveredId);
  const hoveredBox = hovered?.id === undefined ? undefined : outlineBoxes.get(hovered.id);
  const marked = marks.flatMap((mark) => {
    const element = elements.find((candidate) => candidate.id === mark.elementId);
    const box = outlineBoxes.get(mark.elementId);
    return element && box ? [{ ...mark, box, kind: element.kind }] : [];
  });
  const pinned = threads.flatMap((thread) => {
    const spot = thread.target.kind === "canvas-element" ? pinSpots.get(thread.target.elementId) : undefined;
    return spot ? [{ thread, spot }] : [];
  });

  // A link card in comment mode is aimed at, not followed.
  const keepLinksFromNavigating = (event: MouseEvent<HTMLDivElement>) => {
    if ((picking || event.altKey) && (event.target as Element).closest("[data-canvas-element-id]")) event.preventDefault();
  };

  return (
    <>
      <div ref={underRef} style={{ display: "contents" }} onClickCapture={keepLinksFromNavigating}>
        {under.map((element, i) => (
          <CanvasElement key={i} element={element} assetBase={assetBase} artboardOrigin={artboardOrigin} commentable={picking && element.id !== undefined} />
        ))}
      </div>
      {children}
      <div ref={overRef} style={{ display: "contents" }} onClickCapture={keepLinksFromNavigating}>
        {over.map((element, i) => {
          if (element.kind !== "arrow") {
            return <CanvasElement key={i} element={element} assetBase={assetBase} artboardOrigin={artboardOrigin} commentable={picking && element.id !== undefined} />;
          }
          const geometry = arrowGeometries.get(element);
          return (
            <div key={i} style={{ display: "contents" }}>
              {geometry && <CanvasArrow arrow={element} geometry={geometry} commentable={picking && element.id !== undefined} />}
            </div>
          );
        })}
      </div>
      {hovered && hoveredBox && (
        <>
          <div
            data-testid="canvas-hover-outline"
            className={styles.hoverOutline}
            style={{ left: hoveredBox.x, top: hoveredBox.y, width: hoveredBox.width, height: hoveredBox.height, borderRadius: OUTLINE_RADIUS[hovered.kind], ...hoverOutlineStyle }}
          />
          <span
            data-testid="canvas-hover-label"
            className={styles.hoverLabel}
            style={{ left: hoveredBox.x + HOVER_FINISH.labelOffsetX, top: hoveredBox.y + HOVER_FINISH.labelOffsetY, ...hoverLabelStyle }}
          >
            {CANVAS_ELEMENT_KIND_LABELS[hovered.kind]} · {hovered.id}
          </span>
        </>
      )}
      {marked.map(({ number, elementId, box, kind }) => (
        <div key={elementId} data-canvas-mark-box={elementId} style={{ display: "contents" }}>
          <div className={styles.hoverOutline} style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: OUTLINE_RADIUS[kind], ...hoverOutlineStyle }} />
          <span data-canvas-mark={number} className={styles.markBadge} style={{ left: box.x + MARK_FINISH.badgeOffset, top: box.y + MARK_FINISH.badgeOffset, ...markBadgeStyle }}>
            {number}
          </span>
        </div>
      ))}
      {pinned.map(({ thread, spot }) => {
        const resolved = thread.status === "resolved";
        return (
          <span
            key={thread.id}
            data-canvas-pin={thread.number}
            title={`${thread.title} · ${threadWhere(thread)}`}
            className={cx(styles.pin, thread.status === "held" && styles.pinHeld, resolved && styles.pinResolved)}
            style={{ left: spot.x, top: spot.y, transform: `translate(calc(-50% - ${spot.inset ? PIN_INSET / zoom : 0}px), calc(-50% + ${spot.inset ? PIN_INSET / zoom : 0}px)) scale(${1 / zoom})` }}
          >
            {resolved ? "✓" : thread.number}
          </span>
        );
      })}
    </>
  );
}
