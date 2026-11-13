import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ArtboardRef, ChangeReview, ChangeReviewAnswer } from "@redline/shared";
import { cx } from "./ui/index.js";
import styles from "./ReviewScreen.module.css";

const SAVE_DELAY_MS = 600;
const UNDO_DELAY_MS = 5_000;

export const personName = (person: { name: string; email: string } | undefined) => person?.name || person?.email || "quelqu'un";

export function PersonDot({ person }: { person: { initials: string } | undefined }) {
  return person ? (
    <span aria-hidden="true" className={styles.avatar}>
      {person.initials}
    </span>
  ) : null;
}

/** What a remark on a group needs to know: the artboard on the stage, and how to name an artboard of the group. */
export interface RemarkPlacement {
  shown: ArtboardRef;
  example: ArtboardRef;
  titleOf: (artboard: ArtboardRef) => string;
}

/** The member's own remark on a step: saved on its own while they type, editable until the review is finished, deletable with a short undo. */
export function RemarkEditor({
  reviewPath,
  stepId,
  own,
  finished,
  placement,
  onReview,
  onReload,
  onUnsaved,
  onKeptUnsaved,
}: {
  reviewPath: string;
  stepId: string;
  own: ChangeReviewAnswer | undefined;
  finished: boolean;
  /** Present on a group: a remark is attached to the artboard shown when it was started. */
  placement?: RemarkPlacement;
  onReview: (review: ChangeReview) => void;
  onReload: () => void;
  onUnsaved: (unsaved: boolean) => void;
  /** Tells the step whether the locked review keeps text Redline never received. */
  onKeptUnsaved: (unsaved: boolean) => void;
}) {
  const savedText = own?.kind === "remark" ? own.text ?? "" : undefined;
  const [text, setText] = useState(savedText ?? "");
  const [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const saving = useRef(false);
  /** Where a new remark on a group starts: the artboard shown at the first keystroke, kept when the stage changes. */
  const [startedOn, setStartedOn] = useState<ArtboardRef | undefined>();
  const latest = useRef({ text, savedText, ownId: own?.id, startedOn });
  latest.current = { text, savedText, ownId: own?.id, startedOn };
  const placedOn = placement && (own?.kind === "remark" ? own.on ?? placement.example : startedOn);
  const deleteTimer = useRef<ReturnType<typeof setTimeout>>();

  const unsaved = !finished && !deleting && text.trim() !== "" && text !== savedText;
  useEffect(() => onUnsaved(unsaved), [unsaved, onUnsaved]);
  useEffect(() => () => onUnsaved(false), [onUnsaved]);

  const save = useCallback(async () => {
    if (saving.current) return;
    const { text: toSave, startedOn: on } = latest.current;
    saving.current = true;
    const response = await fetch(`${reviewPath}/steps/${stepId}/remark`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: toSave, ...(on ? { pageId: on.pageId, artboard: on.artboard } : {}) }),
    }).catch(() => undefined);
    saving.current = false;
    if (!response?.ok) {
      setFailed(true);
      // A 409 means the review was finished meanwhile: the text stays here, read-only.
      if (response?.status === 409) onReload();
      return;
    }
    setFailed(false);
    onReview((await response.json()) as ChangeReview);
  }, [reviewPath, stepId, onReview, onReload]);

  const removeNow = useCallback(async () => {
    deleteTimer.current = undefined;
    const { ownId } = latest.current;
    if (!ownId) return;
    const response = await fetch(`${reviewPath}/remarks/${ownId}`, { method: "DELETE" }).catch(() => undefined);
    if (response?.ok) onReview((await response.json()) as ChangeReview);
    else if (response?.status === 409) onReload();
    setDeleting(false);
  }, [reviewPath, onReview, onReload]);

  // Autosave: a pause in typing saves, and saves again if the text changed during the request.
  useEffect(() => {
    if (finished || deleting || text.trim() === "" || text === savedText) return;
    const timer = setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, savedText, finished, deleting, save]);

  // An emptied text is a deletion, with the same undo as "Effacer".
  useEffect(() => {
    if (!finished && savedText !== undefined && text.trim() === "" && !deleting) startDeleting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function startDeleting() {
    setDeleting(true);
    deleteTimer.current = setTimeout(() => void removeNow(), UNDO_DELAY_MS);
  }

  function undoDeleting() {
    clearTimeout(deleteTimer.current);
    deleteTimer.current = undefined;
    setText(savedText ?? "");
    setDeleting(false);
  }

  // Leaving the step makes a pending deletion final.
  useEffect(
    () => () => {
      if (deleteTimer.current && latest.current.ownId) {
        clearTimeout(deleteTimer.current);
        void fetch(`${reviewPath}/remarks/${latest.current.ownId}`, { method: "DELETE" }).catch(() => undefined);
      }
    },
    [reviewPath],
  );

  // Locked while the member was typing: what they typed stays here, read-only, marked as not saved when Redline never received it.
  const kept = text.trim() !== "" ? text : savedText ?? "";
  const keptUnsaved = finished && kept.trim() !== "" && kept !== savedText;
  useEffect(() => onKeptUnsaved(keptUnsaved), [keptUnsaved, onKeptUnsaved]);

  const copy = () => {
    void navigator.clipboard?.writeText(kept).then(() => setCopied(true));
  };

  if (finished) {
    if (kept.trim() === "") return null;
    return (
      <div className={styles.section}>
        <label className={styles.label} htmlFor="remark">
          Ta remarque{keptUnsaved ? " (non enregistrée)" : ""}
        </label>
        <textarea id="remark" className={styles.textarea} readOnly value={kept} />
        <span className={styles.errorLine}>
          {keptUnsaved ? "Non enregistré · " : ""}
          <button type="button" className={styles.linkButton} onClick={copy}>
            {copied ? "Copié" : "Copier"}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <label className={styles.label} htmlFor="remark">
        {placement ? (placedOn ? `Remarque sur ${placement.titleOf(placedOn)}` : "Ou une remarque pour tout le groupe") : "Ou une remarque"}
      </label>
      {deleting ? (
        <span className={styles.author}>
          Remarque effacée
          <button type="button" className={cx(styles.linkButton, styles.hint)} onClick={undoDeleting}>
            Annuler
          </button>
        </span>
      ) : (
        <>
          <textarea
            id="remark"
            className={styles.textarea}
            value={text}
            placeholder={placement ? "Elle s'attache à l'artboard affiché et cite les autres" : "Ce qui ne va pas, ce que tu veux à la place"}
            onChange={(event) => {
              setText(event.target.value);
              if (placement && own?.kind !== "remark") setStartedOn(event.target.value.trim() === "" ? undefined : startedOn ?? placement.shown);
            }}
          />
          {own?.outdated && !unsaved && !failed && (
            <span className={styles.author}>
              <PersonDot person={own.person} />
              Ta remarque d'avant la modification, gardée
            </span>
          )}
          {savedText !== undefined && !own?.outdated && !unsaved && !failed && (
            <span className={styles.author}>
              <PersonDot person={own?.person} />
              Toi · enregistré · modifiable jusqu'à la fin de la revue
              <span className={styles.authorSpacer} />
              <button type="button" className={cx(styles.panelButton, styles.smallButton)} onClick={startDeleting}>
                Effacer
              </button>
            </span>
          )}
          {failed && (
            <span className={styles.errorLine} role="alert">
              Pas enregistré : Redline ne répond pas.
              <button type="button" className={styles.linkButton} onClick={() => void save()}>
                Réessayer
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** The warning of the mock-up when the member leaves a step with a remark Redline has not received. */
export function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return (
    <div className={styles.leaveOverlay}>
      <div role="dialog" aria-modal="true" aria-labelledby="leave-title" className={styles.leaveBox}>
        <h2 id="leave-title">Ta remarque n'est pas enregistrée : quitter quand même ?</h2>
        <p>Redline n'a pas encore reçu ta dernière modification. En quittant maintenant, elle sera perdue.</p>
        <div className={styles.leaveActions}>
          <button type="button" className={styles.panelButton} onClick={onStay} autoFocus>
            Rester
          </button>
          <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onLeave}>
            Quitter sans enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}

/** A modal question with a way out and a way on, in the look of the leave warning. */
export function ConfirmDialog({ title, cancel, confirm, onCancel, onConfirm, children }: { title: string; cancel: string; confirm: string; onCancel: () => void; onConfirm: () => void; children: ReactNode }) {
  return (
    <div className={styles.leaveOverlay}>
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className={cx(styles.leaveBox, styles.confirmBox)}>
        <h2 id="confirm-title">{title}</h2>
        {children}
        <div className={styles.leaveActions}>
          <button type="button" className={styles.panelButton} onClick={onCancel} autoFocus>
            {cancel}
          </button>
          <button type="button" className={cx(styles.panelButton, styles.accent)} onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
