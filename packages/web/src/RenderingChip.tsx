import { createContext, useContext } from "react";
import { cellText, renderingLabel, type ManifestTweak, type Thread } from "@redline/shared";
import { InstanceChip } from "./InstanceThreads.js";
import styles from "./Thread.module.css";

/** The page's tweaks: a toggle value in a grid cell reads with its label ("Icône : non"). */
export const PageTweaksContext = createContext<readonly ManifestTweak[]>([]);

/** "Mobile · 390": the rendering of a responsive artboard the thread is pinned in; "vu en Hover · Outlined": its tweak grid cell. */
export function RenderingChip({ thread }: { thread: Pick<Thread, "rendering" | "cell" | "selector"> }) {
  const tweaks = useContext(PageTweaksContext);
  return (
    <>
      <InstanceChip thread={thread} />
      {thread.rendering && (
        <span data-testid="thread-rendering" className={styles.renderingChip}>
          {renderingLabel(thread.rendering)}
        </span>
      )}
      {thread.cell && (
        <span data-testid="thread-cell" className={styles.renderingChip}>
          vu en {cellText(thread.cell, tweaks)}
        </span>
      )}
    </>
  );
}
