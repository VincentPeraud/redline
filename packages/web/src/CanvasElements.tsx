import { useLayoutEffect, useRef, useState } from "react";
import type { ManifestElement, ManifestTitleElement } from "@redline/shared";
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

/** Add a case here for each new element kind. */
function CanvasElement({ element }: { element: ManifestElement }) {
  switch (element.kind) {
    case "title":
      return <CanvasTitle element={element} />;
  }
}

/** Decoration written by Claude: drawn in list order, not draggable, no comment pins. */
export function CanvasElements({ elements }: { elements: ManifestElement[] }) {
  return (
    <>
      {elements.map((element, i) => (
        <CanvasElement key={i} element={element} />
      ))}
    </>
  );
}
