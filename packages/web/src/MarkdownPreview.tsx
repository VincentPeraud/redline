import type { ReactNode } from "react";
import styles from "./MarkdownPreview.module.css";

/** Read-only rendering of the subset of Markdown a DESIGN.md uses: headings, bullet lists and paragraphs. */
export function MarkdownPreview({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<div key={blocks.length}>{paragraph.join(" ")}</div>);
    paragraph = [];
  };

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={blocks.length} className={styles.list}>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>,
    );
  };

  for (const line of source.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1]!);
      continue;
    }
    flushBullets();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading || line.trim() === "") flushParagraph();
    if (heading) {
      blocks.push(
        <div key={blocks.length} className={styles.heading}>
          {heading[1]}
        </div>,
      );
    } else if (line.trim() !== "") {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushBullets();

  return <div className={styles.preview}>{blocks}</div>;
}
