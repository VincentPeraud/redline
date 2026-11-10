import { createContext, useContext } from "react";
import { instanceStateLabel, instanceStateText, instanceTagOfAnchor, type Thread } from "@redline/shared";
import styles from "./Thread.module.css";

/** Ids of the threads whose element can no longer be found (gone from its component instance, or no element has its name any more), as the artboards' bridges reported them. */
export const MissingInstanceElementsContext = createContext<ReadonlySet<string>>(new Set());

/** Receives the thread ids one iframe (`frameId`) found gone from their instance; an empty list clears it. Set by the canvas, a no-op elsewhere. */
export const ReportMissingInstanceElementsContext = createContext<(frameId: string, threadIds: string[]) => void>(() => undefined);

/** For each thread, the indexes of its remembered instance states that can no longer be replayed, as the artboards' bridges reported them. */
export const UnavailableStatesContext = createContext<ReadonlyMap<string, readonly number[]>>(new Map());

/** Receives, for one iframe (`frameId`), the unavailable state indexes of its threads; an empty record clears it. */
export const ReportUnavailableStatesContext = createContext<(frameId: string, unavailable: Record<string, number[]>) => void>(() => undefined);

/** Thread to replay the remembered instance state of (`nonce` makes a second click on the same thread count); the artboards showing it set the state. */
export interface ReplayRequest {
  threadId: string;
  nonce: number;
}
export const ReplayRequestContext = createContext<ReplayRequest | null>(null);

/** The chips under a card's header: "dans ui-modal" for an element inside an instance, "vu avec confirm ouverte" for the state it was seen in. */
export function InstanceChips({ thread }: { thread: Pick<Thread, "selector" | "instanceState"> }) {
  const tag = instanceTagOfAnchor(thread.selector);
  if (!tag && !thread.instanceState) return null;
  return (
    <div className={styles.instanceChips}>
      {tag && (
        <span data-testid="thread-instance" className={styles.instanceChip}>
          dans {tag}
        </span>
      )}
      {thread.instanceState && (
        <span data-testid="thread-instance-state" className={styles.stateChip}>
          vu avec {instanceStateLabel(thread.instanceState)}
        </span>
      )}
    </div>
  );
}

/** Under the card's header: the commented element left its instance, or part of the remembered state no longer exists; the pin sits on what remains. */
export function InstanceNotes({ thread }: { thread: Pick<Thread, "id" | "selector" | "instanceState"> }) {
  const missing = useContext(MissingInstanceElementsContext);
  const unavailable = useContext(UnavailableStatesContext).get(thread.id);
  const tag = instanceTagOfAnchor(thread.selector);
  const lost = unavailable?.flatMap((index) => (thread.instanceState?.[index] ? [instanceStateText(thread.instanceState[index])] : [])) ?? [];
  const elementGone = tag && missing.has(thread.id);
  const elementLost = !tag && missing.has(thread.id);
  if (!elementGone && !elementLost && lost.length === 0) return null;
  return (
    <>
      {elementLost && (
        <div data-testid="thread-element-lost" className={styles.instanceGone}>
          élément introuvable
        </div>
      )}
      {elementGone && (
        <div data-testid="thread-instance-gone" className={styles.instanceGone}>
          l'élément commenté n'existe plus dans {tag}
        </div>
      )}
      {lost.length > 0 && (
        <div data-testid="thread-state-gone" className={styles.instanceGone}>
          état {lost.join(", ")} plus disponible
        </div>
      )}
    </>
  );
}

/** Chips and notes of a card about the component instances its thread involves. */
export function InstanceThreadInfo({ thread }: { thread: Pick<Thread, "id" | "selector" | "instanceState"> }) {
  return (
    <>
      <InstanceChips thread={thread} />
      <InstanceNotes thread={thread} />
    </>
  );
}
