import { createContext, useContext } from "react";
import { instanceTagOfAnchor, type Thread } from "@redline/shared";
import styles from "./Thread.module.css";

/** Ids of the threads whose element inside a component instance no longer exists, as the artboards' bridges reported them. */
export const MissingInstanceElementsContext = createContext<ReadonlySet<string>>(new Set());

/** Receives the thread ids one iframe (`frameId`) found gone from their instance; an empty list clears it. Set by the canvas, a no-op elsewhere. */
export const ReportMissingInstanceElementsContext = createContext<(frameId: string, threadIds: string[]) => void>(() => undefined);

/** "dans ui-modal": the thread is pinned on an element shown inside that component instance. */
export function InstanceChip({ thread }: { thread: Pick<Thread, "selector"> }) {
  const tag = instanceTagOfAnchor(thread.selector);
  if (!tag) return null;
  return (
    <span data-testid="thread-instance" className={styles.renderingChip}>
      dans {tag}
    </span>
  );
}

/** Under the card's header: the commented element left its instance, the pin sits on the whole instance. */
export function InstanceGoneNote({ thread }: { thread: Pick<Thread, "id" | "selector"> }) {
  const missing = useContext(MissingInstanceElementsContext);
  const tag = instanceTagOfAnchor(thread.selector);
  if (!tag || !missing.has(thread.id)) return null;
  return (
    <div data-testid="thread-instance-gone" className={styles.instanceGone}>
      l'élément commenté n'existe plus dans {tag}
    </div>
  );
}
