import { createContext, useContext } from "react";
import { cellText, renderingLabel, sandboxTrialText, type ManifestTweak, type Thread } from "@redline/shared";
import { FlaskIcon } from "./SandboxCard.js";
import styles from "./Thread.module.css";

/** The page's tweaks: a toggle value in a grid cell reads with its label ("Icône : non"). */
export const PageTweaksContext = createContext<readonly ManifestTweak[]>([]);

/** "Mobile · 390": the rendering of a responsive artboard the thread is pinned in; "vu en Hover · Outlined": its tweak grid cell. */
export function RenderingChip({ thread }: { thread: Pick<Thread, "rendering" | "cell"> }) {
  const tweaks = useContext(PageTweaksContext);
  return (
    <>
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

/** "Vu en bac à sable : secondary · lg · Contenu « … »": what the component sandbox showed when the thread was written in it. */
export function SandboxSeen({ thread }: { thread: Pick<Thread, "sandbox"> }) {
  const tweaks = useContext(PageTweaksContext);
  if (!thread.sandbox) return null;
  const text = sandboxTrialText(thread.sandbox, tweaks);
  return (
    <div data-testid="thread-sandbox" className={styles.sandboxSeen}>
      <span className={styles.sandboxSeenIcon}>
        <FlaskIcon />
      </span>
      <span>Vu en bac à sable{text ? ` : ${text}` : ""}</span>
    </div>
  );
}
