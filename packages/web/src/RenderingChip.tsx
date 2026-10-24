import { renderingLabel, type Thread } from "@redline/shared";
import styles from "./Thread.module.css";

/** "Mobile · 390": the rendering of a responsive artboard the thread is pinned in. */
export function RenderingChip({ thread }: { thread: Pick<Thread, "rendering"> }) {
  return thread.rendering ? (
    <span data-testid="thread-rendering" className={styles.renderingChip}>
      {renderingLabel(thread.rendering)}
    </span>
  ) : null;
}
