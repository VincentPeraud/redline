import { useState } from "react";
import type { SendHeldRequest, Thread, UpdateThreadRequest } from "@redline/shared";
import type { ModelEffortChoice } from "./ModelEffortControls.js";
import { MessageAuthor } from "./MessageAuthor.js";
import { InstanceThreadInfo } from "./InstanceThreads.js";
import { RemovedTag } from "./RemovedTag.js";
import { RenderingChip } from "./RenderingChip.js";
import { threadWhere, wholeArtboardOf } from "./threadLabel.js";
import { Button, Dialog, DialogActions, Textarea, Tooltip, cx } from "./ui/index.js";
import { DIALOG_EXIT_MS } from "./ui/Dialog.js";
import styles from "./Thread.module.css";

const SENT_AS: Record<"conversation" | "agent" | "review", string> = {
  conversation: "ils seront à prendre par une conversation.",
  agent: "ils partiront ensemble à l'agent.",
  review: "ils seront à relire par un membre en Écriture.",
};

/** Bar "N brouillons, à toi seul · Tout envoyer": the viewer's own drafts leave together; the line says what they become once sent. */
export function HeldBar({ pageId, count, choice, sentAs }: { pageId: string; count: number; choice: ModelEffortChoice; sentAs: keyof typeof SENT_AS }) {
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
      <div className={styles.heldText}>
        <span className={styles.heldCount}>{count === 1 ? "1 brouillon" : `${count} brouillons`}, à toi seul</span>
        <span className={styles.heldHint}>Ni Claude ni les autres membres ne les voient. Une fois envoyés, {SENT_AS[sentAs]}</span>
      </div>
      <Button variant="accent" size="sm" onClick={() => void sendAll()}>
        Tout envoyer
      </Button>
    </div>
  );
}

/** "Supprimer ce brouillon ?": nobody else saw it, so the dialog only names it and asks once. */
function DeleteDraftDialog({ thread, closing, onCancel, onDelete }: { thread: Thread; closing: boolean; onCancel: () => void; onDelete: () => void }) {
  return (
    <Dialog title="Supprimer ce brouillon ?" width={360} onClose={onCancel} closing={closing} alert>
      <p className={styles.dialogText}>« {thread.body} » sera supprimé. Personne ne l'a vu.</p>
      <DialogActions>
        <Button onClick={onCancel}>Annuler</Button>
        <Button variant="danger" onClick={onDelete}>
          Supprimer
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** A draft: dashed, labelled "Brouillon", editable and deletable (after a confirmation) until its author sends it. */
export function HeldThreadCard({ thread }: { thread: Thread }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(thread.body);
  const [deleting, setDeleting] = useState<"open" | "closing" | null>(null);

  const closeDialog = (then?: () => void) => {
    setDeleting("closing");
    setTimeout(() => {
      setDeleting(null);
      then?.();
    }, DIALOG_EXIT_MS);
  };

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
    <article data-testid="held-thread" data-thread={thread.id} data-whole-artboard={wholeArtboardOf(thread)} className={cx(styles.card, styles.held, thread.removed && styles.removed)}>
      <div className={styles.head}>
        <span className={cx(styles.badge, styles.badgeHeld, thread.removed && styles.badgeRemoved)}>{thread.number}</span>
        <span className={styles.where}>{threadWhere(thread)}</span>
        <RenderingChip thread={thread} />
        <span className={styles.spacer} />
        {thread.removed && <RemovedTag />}
        <span className={styles.headRight}>
          <span className={styles.heldLabel}>Brouillon</span>
          {!editing && (
            <span className={styles.heldActions}>
              <Tooltip label="Modifier">
                <button type="button" aria-label="Modifier" className={styles.iconAction} onClick={() => setEditing(true)}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 20h4L19 9l-4-4L4 16v4z" />
                    <path d="M13 7l4 4" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip label="Supprimer">
                <button type="button" aria-label="Supprimer" className={styles.iconAction} onClick={() => setDeleting("open")}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 7h16" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                    <path d="M6 7l1 13h10l1-13" />
                    <path d="M9 7V4h6v3" />
                  </svg>
                </button>
              </Tooltip>
            </span>
          )}
        </span>
      </div>
      <InstanceThreadInfo thread={thread} />
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
            <MessageAuthor person={thread.person} />
            {thread.body}
          </div>
        </>
      )}
      {deleting && (
        <DeleteDraftDialog thread={thread} closing={deleting === "closing"} onCancel={() => closeDialog()} onDelete={() => closeDialog(() => void fetch(`/api/threads/${thread.id}`, { method: "DELETE" }))} />
      )}
    </article>
  );
}
