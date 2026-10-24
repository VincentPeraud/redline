import type { CSSProperties } from "react";
import type { ManifestStickyElement, ManifestTextElement } from "@redline/shared";
import { paletteShades } from "./canvasPalette.js";
import { parseNoteMarkdown, type NoteInline } from "./noteMarkdown.js";
import styles from "./CanvasNotes.module.css";

/** Font size in canvas pixels for the sizes `s`, `m`, `l`. */
const NOTE_FONT_SIZE = { s: 22, m: 26, l: 30 } as const;

function Inline({ part }: { part: NoteInline }) {
  switch (part.type) {
    case "text":
      return <>{part.text}</>;
    case "bold":
      return <strong>{part.text}</strong>;
    case "italic":
      return <em>{part.text}</em>;
    case "link":
      return (
        <a href={part.href} target="_blank" rel="noopener noreferrer">
          {part.text}
        </a>
      );
  }
}

function NoteBody({ text }: { text: string }) {
  return (
    <>
      {parseNoteMarkdown(text).map((block, i) =>
        block.type === "paragraph" ? (
          <p key={i} className={styles.paragraph}>
            {block.content.map((part, j) => (
              <Inline key={j} part={part} />
            ))}
          </p>
        ) : (
          <ul key={i} className={styles.list}>
            {block.items.map((item, j) => (
              <li key={j}>
                {item.map((part, k) => (
                  <Inline key={k} part={part} />
                ))}
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

export function CanvasTextNote({ element }: { element: ManifestTextElement }) {
  const style: CSSProperties = { left: element.x, top: element.y, width: element.width, fontSize: NOTE_FONT_SIZE[element.size] };
  if (element.color) style.color = paletteShades(element.color).text;
  return (
    <div data-canvas-text className={styles.text} style={style}>
      <NoteBody text={element.text} />
    </div>
  );
}

export function CanvasStickyNote({ element }: { element: ManifestStickyElement }) {
  const shades = paletteShades(element.color);
  const style: CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.width,
    fontSize: NOTE_FONT_SIZE[element.size],
    background: shades.fill,
    color: shades.text,
  };
  return (
    <div data-canvas-sticky className={styles.sticky} style={style}>
      <NoteBody text={element.text} />
    </div>
  );
}
