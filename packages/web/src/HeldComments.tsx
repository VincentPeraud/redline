import { useState } from "react";
import type { SendHeldRequest, Thread, UpdateThreadRequest } from "@redline/shared";
import type { ModelEffortChoice } from "./ModelEffortControls.js";
import { threadWhere } from "./threadLabel.js";
import { Button, Textarea, cx } from "./ui/index.js";
import styles from "./Thread.module.css";

/** Bar "N en attente d'envoi · Tout envoyer": the held comments of the open page leave together, as one message. */
export function HeldBar({ pageId, count, choice }: { pageId: string; count: number; choice: ModelEffortChoice }) {
  async function sendAll() {
    const request: SendHeldRequest = choice;
    await fetch(`/api/pages/${pageId}/send-held`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  if (count === 0) return null;
  return (
    <div data-testid="held-bar" className={styles.heldBar}>
      <span className={styles.heldCount}>{count} en attente d'envoi</span>
      <span className={styles.heldHint}>part avec les suivants</span>
      <span className={styles.spacer} />
      <Button variant="accent" size="sm" onClick={() => void sendAll()}>
        Tout envoyer
      </Button>
    </div>
  );
}

/** A held comment: dashed, labelled "En attente d'envoi", editable and deletable until it is sent. */
export function HeldThreadCard({ thread }: { thread: Thread }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(thread.body);

  async function save() {
    if (text.trim() === "") return;
    const request: UpdateThreadRequest = { body: text };
    await fetch(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    setEditing(false);
  }

  return (
    <article data-testid="held-thread" className={cx(styles.card, styles.held)}>
      <div className={styles.head}>
        <span className={cx(styles.badge, styles.badgeHeld)}>{thread.number}</span>
        <span className={styles.where}>{threadWhere(thread)}</span>
        <span className={styles.spacer} />
        <span className={styles.headRight}>
          <span className={styles.heldLabel}>En attente d'envoi</span>
          {!editing && (
            <span className={styles.heldActions}>
              <button type="button" aria-label="Modifier" title="Modifier" className={styles.iconAction} onClick={() => setEditing(true)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 20h4L19 9l-4-4L4 16v4z" />
                  <path d="M13 7l4 4" />
                </svg>
              </button>
              <button type="button" aria-label="Supprimer" title="Supprimer" className={styles.iconAction} onClick={() => void fetch(`/api/threads/${thread.id}`, { method: "DELETE" })}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 7h16" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M6 7l1 13h10l1-13" />
                  <path d="M9 7V4h6v3" />
                </svg>
              </button>
            </span>
          )}
        </span>
      </div>
      {editing ? (
        <>
          <Textarea aria-label="Modifier le commentaire" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <div className={styles.replyActions}>
            <Button
              size="sm"
              onClick={() => {
                setText(thread.body);
                setEditing(false);
              }}
            >
              Annuler
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()}>
              Enregistrer
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.message}>
            <span className={styles.author}>Toi</span> — {thread.body}
          </div>
        </>
      )}
    </article>
  );
}
