import { useState } from "react";
import type { SendHeldRequest, Thread, UpdateThreadRequest } from "@redline/shared";
import type { ModelEffortChoice } from "./ModelEffortControls.js";
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
        <span className={styles.where}>
          {thread.artboard} · {thread.selector}
        </span>
        <span className={styles.spacer} />
        <span className={styles.headRight}>En attente d'envoi</span>
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
          <div className={styles.replyActions}>
            <Button size="sm" onClick={() => setEditing(true)}>
              Modifier
            </Button>
            <Button size="sm" onClick={() => void fetch(`/api/threads/${thread.id}`, { method: "DELETE" })}>
              Supprimer
            </Button>
          </div>
        </>
      )}
    </article>
  );
}
