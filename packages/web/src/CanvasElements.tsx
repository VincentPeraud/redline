import { useLayoutEffect, useRef, useState } from "react";
import type { ManifestElement, ManifestImageElement, ManifestTitleElement } from "@redline/shared";
import { CanvasStickyNote, CanvasTextNote } from "./CanvasNotes.js";
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

/** Add a case here for each new element kind. */
function CanvasElement({ element, assetBase }: { element: ManifestElement; assetBase: string }) {
  switch (element.kind) {
    case "title":
      return <CanvasTitle element={element} />;
    case "text":
      return <CanvasTextNote element={element} />;
    case "sticky":
      return <CanvasStickyNote element={element} />;
    case "image":
      return <CanvasImage element={element} assetBase={assetBase} />;
  }
}

/** Decoration written by Claude: drawn in list order, not draggable, no comment pins. */
export function CanvasElements({ elements, assetBase }: { elements: ManifestElement[]; assetBase: string }) {
  return (
    <>
      {elements.map((element, i) => (
        <CanvasElement key={i} element={element} assetBase={assetBase} />
      ))}
    </>
  );
}
