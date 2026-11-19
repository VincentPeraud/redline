import { useEffect, useState } from "react";
import type { DraftChangeUsers } from "@redline/shared";
import { Button, DIALOG_EXIT_MS, Dialog, DialogActions, Field, Textarea } from "./ui/index.js";
import styles from "./RefuseDialog.module.css";

/** What a "Refuser" refuses: its dialog title and the route that records the refusal. */
export interface RefusalTarget {
  /** « Refuser « <label> » », or « Refuser la demande sur ui-x » for a whole request. */
  title: string;
  url: string;
  /** Route listing the pages of projects on the draft that use the change; absent for a whole request. */
  usersUrl?: string;
}

export const refuseChangeTarget = (changeId: string, label: string): RefusalTarget => ({ title: `Refuser « ${label} »`, url: `/api/changes/${changeId}/refuse`, usersUrl: `/api/changes/${changeId}/draft-users` });
export const refuseRequestTarget = (threadId: string, tag: string): RefusalTarget => ({ title: `Refuser la demande sur ${tag}`, url: `/api/threads/${threadId}/refuse` });

/** Small dialog over the content: the user may explain a refusal (facultatif); Annuler refuses nothing. */
export function RefuseDialog({ target, onClose, onRefused }: { target: RefusalTarget; onClose: () => void; onRefused: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [draftPages, setDraftPages] = useState<DraftChangeUsers["pages"]>([]);

  useEffect(() => {
    if (!target.usersUrl) return;
    let current = true;
    void fetch(target.usersUrl)
      .then((response) => response.json() as Promise<DraftChangeUsers>)
      .then((users) => current && setDraftPages(users.pages));
    return () => {
      current = false;
    };
  }, [target.usersUrl]);

  const close = (after: () => void) => {
    setClosing(true);
    setTimeout(after, DIALOG_EXIT_MS);
  };

  // Escape closes this dialog only, not the dialog it may sit on.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      close(onClose);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const refuse = async () => {
    setBusy(true);
    await fetch(target.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: answer.trim() }) });
    close(() => {
      onRefused();
      onClose();
    });
  };

  return (
    <Dialog title={target.title} onClose={() => close(onClose)} width={480} gap={16} closing={closing}>
      {draftPages.length > 0 && (
        <div className={styles.draftPages} data-testid="refuse-draft-pages">
          <p>Ces pages de projets sur le brouillon utilisent ce composant, elles seront touchées :</p>
          <ul>
            {draftPages.map((page) => (
              <li key={page.pageId}>
                {page.projectTitle} · {page.pageTitle}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Field label="Ta réponse" optional>
        <Textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={4} className={styles.answer} autoFocus data-testid="refuse-answer" />
      </Field>
      <DialogActions>
        <Button size="lg" onClick={() => close(onClose)}>
          Annuler
        </Button>
        <Button size="lg" variant="primary" disabled={busy} onClick={() => void refuse()} data-testid="refuse-confirm">
          Refuser
        </Button>
      </DialogActions>
    </Dialog>
  );
}
