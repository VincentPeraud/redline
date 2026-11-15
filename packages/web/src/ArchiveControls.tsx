import { useEffect, useState } from "react";
import type { ArchiveRefusal, ArchiveStatus } from "@redline/shared";
import { counted } from "./plural.js";
import { subscribeServerEvents } from "./serverEvents.js";
import { Button, Dialog, DialogActions, Field, TextInput, Tooltip, cx } from "./ui/index.js";
import { hostRevealButton } from "./Rename.js";
import { useProjectSharing } from "./ProjectSharingDialog.js";
import { useMe } from "./useMe.js";
import styles from "./ArchiveControls.module.css";

/** A project, a design system or a page: all are archived, unarchived and deleted the same way (a design system's id is its project's). */
export type ArchiveKind = "project" | "designSystem" | "page";

const WORDS: Record<ArchiveKind, { what: string; archivedSection: string; archivedOn: string }> = {
  project: { what: "ce projet", archivedSection: "Projets archivés", archivedOn: "Projet archivé le" },
  designSystem: { what: "ce design system", archivedSection: "Design systems archivés", archivedOn: "Design system archivé le" },
  page: { what: "cette page", archivedSection: "Pages archivées", archivedOn: "Page archivée le" },
};

/** Where a project's or design system's archive routes live (`/api/projects/:id`), and a page's (`/api/pages/:id`). */
const archiveBase = (kind: ArchiveKind, id: string) => (kind === "page" ? `/api/pages/${id}` : `/api/projects/${id}`);

const shortDate = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(new Date(iso));

/** "Archivé le 27 oct.", for the cards of the archived screens. */
export const archivedOnLabel = (iso: string) => `Archivé le ${shortDate(iso)}`;

/** "archivée le 28 oct.", for the cards of archived pages. */
export const pageArchivedOnLabel = (iso: string) => `archivée le ${shortDate(iso)}`;

export function ArchiveIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

function refusalLabel(kind: ArchiveKind, refusal: ArchiveRefusal): string {
  if (refusal.reason === "busy") return `Un agent travaille sur ${WORDS[kind].what} : attends qu'il ait fini pour l'archiver.`;
  const archived = refusal.projects.filter((project) => project.archived).length;
  const followers = counted(refusal.projects.length, "projet", "projets");
  return `Suivi par ${followers}${archived > 0 ? `, dont ${archived} ${archived > 1 ? "archivés" : "archivé"}` : ""} : change d'abord leur design system.`;
}

/** Why archiving is refused now, refreshed when work starts or ends anywhere (the project page stays open meanwhile). */
export function useArchiveRefusal(kind: ArchiveKind, id: string): ArchiveRefusal | undefined | null {
  const [refusal, setRefusal] = useState<ArchiveRefusal | undefined | null>(null);
  useEffect(() => {
    const load = () =>
      fetch(`${archiveBase(kind, id)}/archive`)
        .then((res): Promise<ArchiveStatus> | ArchiveStatus => (res.ok ? (res.json() as Promise<ArchiveStatus>) : {}))
        .then((status) => setRefusal(status.refusal));
    void load();
    return subscribeServerEvents((event) => {
      if (event.type === "work" || event.type === "work-dispatched" || event.type === "run-updated" || event.type === "queue-updated") void load();
    }, () => void load());
  }, [kind, id]);
  return refusal;
}

/** The archive icon of a page card in the project overview, shown on hover next to the rename pencil; disabled, with the reason, while an agent works on the page. */
export function PageArchiveButton({ pageId, onArchived }: { pageId: string; onArchived: () => void }) {
  const refusal = useArchiveRefusal("page", pageId);
  const [error, setError] = useState<string | null>(null);
  const blocked = refusal !== undefined && refusal !== null;
  // A failed click's message lasts until the refusal is known again (an agent started or finished meanwhile).
  useEffect(() => setError(null), [refusal]);
  const tooltip = error ?? (blocked ? refusalLabel("page", refusal) : "Archiver la page");

  async function archive() {
    if (blocked) return;
    const res = await fetch(`/api/pages/${pageId}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    if (res?.ok) return onArchived();
    const body = res ? ((await res.json().catch(() => ({}))) as Partial<ArchiveRefusal>) : {};
    setError(body.reason === "busy" ? refusalLabel("page", { error: "", reason: "busy" }) : "L'archivage a été refusé, recharge la page.");
  }

  return (
    <Tooltip label={tooltip}>
      <button type="button" aria-label="Archiver la page" aria-disabled={blocked} className={cx(hostRevealButton("page"), styles.cardArchive)} onClick={() => void archive()}>
        <ArchiveIcon size={15} />
      </button>
    </Tooltip>
  );
}

/** The discreet "Archiver ce projet" link at the very bottom of a project or design system page, then its confirmation. */
export function ArchiveFooter({ kind, id, title, onArchived }: { kind: ArchiveKind; id: string; title: string; onArchived: () => void }) {
  const refusal = useArchiveRefusal(kind, id);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = refusal !== undefined;

  async function archive() {
    const res = await fetch(`${archiveBase(kind, id)}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? `Archivage refusé (${res.status})`);
      return;
    }
    setConfirming(false);
    onArchived();
  }

  return (
    <div className={styles.footer}>
      <button type="button" className={styles.archiveLink} aria-disabled={blocked} onClick={() => !blocked && setConfirming(true)}>
        <ArchiveIcon size={14} />
        Archiver {WORDS[kind].what}
      </button>
      {refusal && <span className={styles.refusal}>{refusalLabel(kind, refusal)}</span>}
      {confirming && (
        <Dialog title={`Archiver « ${title} » ?`} width={480} onClose={() => setConfirming(false)}>
          <p className={styles.dialogText}>
            {kind === "project" ? (
              <>
                Le projet passe dans <strong>{WORDS[kind].archivedSection}</strong>. Tu pourras toujours consulter ses pages et ses fils, mais plus commenter ni publier, et les agents ne le verront plus. Tu peux
                le désarchiver à tout moment.
              </>
            ) : (
              <>
                Le design system passe dans <strong>{WORDS[kind].archivedSection}</strong>. Tu pourras toujours consulter ses pages, mais plus les commenter, les publier ni le diffuser. On ne pourra plus le
                choisir pour un projet, et les agents ne le verront plus. Tu peux le désarchiver à tout moment.
              </>
            )}
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <DialogActions>
            <Button size="lg" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button size="lg" variant="primary" onClick={() => void archive()}>
              Archiver
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  );
}

/** What deleting an archived item from its banner needs: its title (typed again) and what goes with it ("Ses 2 artboards, 1 fil…"). */
export interface BannerDeletion {
  title: string;
  /** Read when the dialog opens. */
  contents: () => Promise<string>;
  onDeleted: () => void;
}

/**
 * The banner under the header of an archived project, design system or page: it is read-only, "Désarchiver" brings it
 * back; an archived page's banner also offers "Supprimer définitivement" (`deletion`).
 */
export function ArchivedBanner({ kind, id, archivedAt, onUnarchived, deletion, className }: { kind: ArchiveKind; id: string; archivedAt: string; onUnarchived: () => void; deletion?: BannerDeletion; className?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState<string | null>(null);
  // Unarchiving a project stays with its creator and the admins, like archiving it; without accounts everyone manages.
  const hasAccounts = useMe()?.account !== undefined;
  const { sharing } = useProjectSharing(id, undefined, kind === "project" && hasAccounts);
  const canUnarchive = kind !== "project" || !hasAccounts || sharing?.canChange === true;
  async function unarchive() {
    const res = await fetch(`${archiveBase(kind, id)}/unarchive`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    if (res?.ok) onUnarchived();
    else setError("Le désarchivage a échoué, réessaie.");
  }
  const readOnly =
    kind === "project"
      ? "lecture seule : on ne peut plus commenter ni publier, et les agents ne le voient plus."
      : kind === "page"
        ? "lecture seule : on ne peut plus commenter ni publier, et les agents ne la voient plus."
        : "lecture seule : on ne peut plus le commenter, le publier ni le diffuser, ni le choisir pour un projet.";
  return (
    <div role="status" className={cx(styles.banner, className)}>
      <span className={styles.bannerIcon}>
        <ArchiveIcon size={18} />
      </span>
      <span className={styles.bannerText}>
        <strong>
          {WORDS[kind].archivedOn} {shortDate(archivedAt)}
        </strong>{" "}
        · {readOnly}
      </span>
      <span className={styles.grow} />
      {error && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
      {deletion && (
        <button
          type="button"
          className={styles.bannerDelete}
          onClick={() =>
            void deletion
              .contents()
              .then(setContents)
              .catch(() => setError("Impossible de préparer la suppression, recharge la page."))
          }
        >
          Supprimer définitivement
        </button>
      )}
      {canUnarchive && <Button onClick={() => void unarchive()}>Désarchiver</Button>}
      {deletion && contents !== null && (
        <DeleteDialog kind={kind} id={id} title={deletion.title} contents={contents} onClose={() => setContents(null)} onDeleted={deletion.onDeleted} />
      )}
    </div>
  );
}

/** The permanent deletion dialog: the red button only works once the name is typed again. */
function DeleteDialog({ kind, id, title, contents, onClose, onDeleted }: { kind: ArchiveKind; id: string; title: string; contents: string; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed.trim() === title;

  async function remove() {
    if (!confirmed) return;
    const res = await fetch(archiveBase(kind, id), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Suppression refusée (${res.status})`);
      return;
    }
    onDeleted();
  }

  return (
    <Dialog title={`Supprimer « ${title} » définitivement ?`} width={520} onClose={onClose}>
      <p className={styles.dialogText}>
        {contents} <strong className={styles.irreversible}>Impossible de revenir en arrière.</strong>
      </p>
      <Field label={`Tape le nom ${kind === "project" ? "du projet" : kind === "page" ? "de la page" : "du design system"} pour confirmer`}>
        <TextInput value={typed} placeholder={title} onChange={(event) => setTyped(event.target.value)} />
      </Field>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <DialogActions>
        <Button size="lg" onClick={onClose}>
          Annuler
        </Button>
        <button type="button" aria-disabled={!confirmed} className={cx(styles.confirmDelete, confirmed && styles.confirmDeleteReady)} onClick={() => void remove()}>
          Supprimer définitivement
        </button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The "Suppression" section at the bottom of an archived project or design system, and its dialog: the red button
 * only works once the name is typed again. `contents` lists what goes ("3 pages, 14 fils, 37 versions").
 */
export function DeleteSection({ kind, id, title, summary, contents, onDeleted }: { kind: ArchiveKind; id: string; title: string; summary: string; contents: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <section aria-labelledby="delete-heading" className={styles.deleteSection}>
      <h2 id="delete-heading" className={styles.deleteHeading}>
        Suppression
      </h2>
      <div className={styles.deleteBox}>
        <div className={styles.deleteInfo}>
          <span className={styles.deleteTitle}>Supprimer définitivement {WORDS[kind].what}</span>
          <span className={styles.deleteText}>{summary}</span>
        </div>
        <button type="button" className={styles.deleteButton} onClick={() => setOpen(true)}>
          Supprimer définitivement
        </button>
      </div>
      {open && <DeleteDialog kind={kind} id={id} title={title} contents={`${contents} seront effacés.`} onClose={() => setOpen(false)} onDeleted={onDeleted} />}
    </section>
  );
}
