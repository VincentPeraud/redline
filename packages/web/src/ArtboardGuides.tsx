import type { ArtboardGuides as Guides } from "@redline/shared";
import styles from "./ArtboardGuides.module.css";

/** Column grid (and optional baseline lines) drawn over an artboard; sizes are canvas pixels, so it scales with the zoom. */
export function ArtboardGuides({ guides }: { guides: Guides }) {
  return (
    <div aria-hidden="true" className={styles.guides} style={{ padding: `0 ${guides.margin}px`, columnGap: guides.gutter, gridTemplateColumns: `repeat(${guides.columns}, minmax(0, 1fr))` }}>
      {Array.from({ length: guides.columns }, (_, i) => (
        <div key={i} data-guide-column className={styles.column} />
      ))}
      {guides.baseline !== undefined && <div data-guide-baseline className={styles.baseline} style={{ backgroundSize: `100% ${guides.baseline}px` }} />}
    </div>
  );
}
