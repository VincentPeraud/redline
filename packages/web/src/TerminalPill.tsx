import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalHolder } from "@redline/shared";
import { relativeTime } from "./relativeTime.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { useCloseOnOutsidePointer } from "./useCloseOnOutsidePointer.js";
import { Button, cx } from "./ui/index.js";
import styles from "./TerminalPill.module.css";

/** The terminal session holding the page, live; none when no present session holds it. */
function useTerminalHolder(pageId: string): TerminalHolder | null {
  const [holder, setHolder] = useState<TerminalHolder | null>(null);
  useEffect(() => {
    const load = () =>
      void fetch(`/api/pages/${pageId}/terminal-holder`)
        .then((res) => (res.ok ? (res.json() as Promise<TerminalHolder | null>) : null))
        .then(setHolder);
    load();
    return subscribeServerEvents((event) => {
      if ((event.type === "terminal-hold-changed" || event.type === "queue-updated") && event.pageId === pageId) load();
    });
  }, [pageId]);
  return holder;
}

/** Canvas header pill saying that a terminal session holds the page: its popover tells which session and what to say to it. */
export function TerminalPill({ pageId }: { pageId: string }) {
  const holder = useTerminalHolder(pageId);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsidePointer(root, open, close);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!holder) return null;
  return (
    <div ref={root} className={styles.root}>
      <button ref={button} type="button" data-testid="terminal-pill" aria-haspopup="dialog" aria-expanded={open} className={cx(styles.pill, open && styles.pillOpen)} onClick={() => setOpen(!open)}>
        <span aria-hidden="true" className={styles.prompt}>
          &gt;_
        </span>
        Session terminal · les commentaires lui iront
      </button>
      {open && (
        <div role="dialog" aria-label="Session terminal" className={styles.popover}>
          <div className={styles.details}>
            <div className={styles.name}>Session terminal</div>
            <div className={styles.folder}>{holder.folder}</div>
            <div className={styles.secondary}>
              {holder.machine} · connectée · a publié la page {relativeTime(holder.since)}
            </div>
          </div>
          <div className={styles.divider} />
          <div className={styles.hint}>Les nouveaux commentaires sur cette page attendent cette session. Dis-lui « traite mes commentaires » dans le terminal.</div>
          <div className={styles.actions}>
            <Button
              size="sm"
              className={styles.handOver}
              onClick={() => {
                setOpen(false);
                void fetch(`/api/pages/${pageId}/terminal-release`, { method: "POST" });
              }}
            >
              Confier la page à l'agent
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
