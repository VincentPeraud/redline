import type { CreatedPage } from "@redline/shared";
import { routeHref } from "./router.js";
import styles from "./CreatedPageCards.module.css";

const MAX_THUMBS = 5;

/** One link card per page the run created, under Claude's answer: "<page name> · N artboards →". */
export function CreatedPageCards({ pages }: { pages: CreatedPage[] | undefined }) {
  if (!pages || pages.length === 0) return null;
  return (
    <>
      {pages.map((page) => (
        <a key={page.pageId} data-testid="created-page" href={routeHref({ name: "page", pageId: page.pageId })} className={styles.card}>
          <span aria-hidden="true" className={styles.thumbs}>
            {Array.from({ length: Math.min(Math.max(page.artboardCount, 1), MAX_THUMBS) }, (_, i) => (
              <span key={i} className={styles.thumb} />
            ))}
          </span>
          <span className={styles.label}>
            {page.name} · {page.artboardCount} {page.artboardCount > 1 ? "artboards" : "artboard"}
          </span>
          <span aria-hidden="true" className={styles.arrow}>
            →
          </span>
        </a>
      ))}
    </>
  );
}
