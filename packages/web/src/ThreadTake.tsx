import type { Thread } from "@redline/shared";
import { relativeTime } from "./relativeTime.js";
import { useMe } from "./useMe.js";
import { cx } from "./ui/index.js";
import styles from "./Thread.module.css";

/** Who handles an open thread, as its card shows it: nobody ("À prendre"), or the account that took it (yours, or someone else's). */
export function useHandler(thread: Thread): { kind: "to-take" } | { kind: "taken"; mine: boolean; name: string; relaunch: boolean; take: NonNullable<Thread["take"]> } | undefined {
  const me = useMe();
  if (thread.toTake) return { kind: "to-take" };
  const { take } = thread;
  if (!take) return undefined;
  // Without SSO there is one account: every take is yours.
  const mine = take.person === undefined ? me === null : take.person.id === me?.id;
  return { kind: "taken", mine, name: take.person?.name || take.person?.email || "quelqu'un", relaunch: thread.relaunch === true, take };
}

/** "À prendre", "Pris par Victor", "Pris par toi" or "Relance pour Victor": the top right of the card. */
export function HandlerStatus({ thread }: { thread: Thread }) {
  const handler = useHandler(thread);
  if (!handler) return null;
  if (handler.kind === "to-take") {
    return (
      <span data-testid="thread-handler" data-handler="to-take" className={cx(styles.status, styles.statusTodo)}>
        À prendre
      </span>
    );
  }
  const label = handler.relaunch ? `Relance pour ${handler.mine ? "toi" : handler.name}` : handler.mine ? "Pris par toi" : `Pris par ${handler.name}`;
  return (
    <span data-testid="thread-handler" data-handler={handler.mine ? "mine" : "other"} className={cx(styles.status, handler.mine && !handler.relaunch && styles.statusMine)}>
      {label}
    </span>
  );
}

const ICONS = {
  person: (
    <>
      <circle cx="7" cy="5" r="2.5" />
      <path d="M2.5 12.5c.6-2.4 2.4-3.5 4.5-3.5s3.9 1.1 4.5 3.5" />
    </>
  ),
  check: <path d="M2.5 7.5l3 3 6-7" />,
  clock: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 4v3.2l2 1.3" />
    </>
  ),
};

/** The block under the messages saying who took the thread, from where and since when (or who the relaunch waits for). */
export function TakenBlock({ thread }: { thread: Thread }) {
  const handler = useHandler(thread);
  if (handler?.kind !== "taken") return null;
  const { mine, name, relaunch, take } = handler;
  const since = relativeTime(take.takenAt);
  const text = relaunch
    ? mine
      ? "Attend une de tes conversations, qui avait pris ce fil"
      : `Attend une conversation de ${name}, qui avait pris ce fil`
    : mine
      ? `Ta conversation l'a pris · ${take.folder} · ${since}`
      : `Une conversation de ${name} l'a pris · ${take.folder} · ${take.machine} · ${since}`;
  const icon = relaunch ? ICONS.clock : mine ? ICONS.check : ICONS.person;
  return (
    <div data-testid="thread-taken" className={cx(styles.taken, mine && !relaunch && styles.takenMine)}>
      <span aria-hidden="true" className={styles.takenIcon}>
        <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
          {icon}
        </svg>
      </span>
      <span className={styles.takenText}>{text}</span>
    </div>
  );
}
