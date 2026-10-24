import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ManifestElement, ManifestLinkElement, ManifestTitleElement, Page, Project } from "@redline/shared";
import { PageThumbnail, usePageArtboards } from "./PageThumbnail.js";
import { routeHref } from "./router.js";
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

/** Add a case here for each new element kind. */
function CanvasElement({ element, artboardOrigin }: { element: ManifestElement; artboardOrigin: string }) {
  switch (element.kind) {
    case "title":
      return <CanvasTitle element={element} />;
    case "link":
      return <CanvasLink element={element} artboardOrigin={artboardOrigin} />;
  }
}

/** Decoration written by Claude: drawn in list order, not draggable, no comment pins. */
export function CanvasElements({ elements, artboardOrigin }: { elements: ManifestElement[]; artboardOrigin: string }) {
  return (
    <>
      {elements.map((element, i) => (
        <CanvasElement key={i} element={element} artboardOrigin={artboardOrigin} />
      ))}
    </>
  );
}
