import { useCallback, useEffect, useState, type FormEvent } from "react";
import { linkPath, type AccessLevel, type CreateLinkRequest, type LinkKind, type Project, type ShareLink } from "@redline/shared";
import { Avatar } from "./Avatar.js";
import { LEVEL_LABEL } from "./ProjectSharingDialog.js";
import { relativeTime } from "./relativeTime.js";
import { routeHref } from "./router.js";
import { useMe } from "./useMe.js";
import { Button, Dialog, DialogActions, Field, Select, SegmentedControl, StatusBadge, TextInput, cx } from "./ui/index.js";
import invite from "./InviteDialog.module.css";
import sharing from "./ProjectSharingDialog.module.css";
import styles from "./PageSharing.module.css";

const JSON_HEADERS = { "content-type": "application/json" };
const DAY_MS = 86_400_000;
/** The levels a link can be created in; Commentaire and Écriture join with their own tickets. */
const OFFERED_LEVELS: AccessLevel[] = ["read"];
const LEVEL_DESCRIPTION: Record<AccessLevel, string> = {
  read: "Regarde la page, le mode présentation et l'aperçu mobile.",
  comment: "Pose des bulles. Elles arrivent « À relire » : un membre les envoie à Claude.",
  write: "Comme un membre sur cette page : commente avec Claude, retouche, restaure.",
};
const KIND_OPTIONS = [
  { value: "personal" as const, label: "Une personne" },
  { value: "generic" as const, label: "Tout le monde avec le lien" },
];

type ExpiryChoice = "14" | "7" | "30" | "date" | "never";
const EXPIRY_CHOICES: { value: ExpiryChoice; label: string }[] = [
  { value: "14", label: "Dans 14 jours" },
  { value: "7", label: "Dans 7 jours" },
  { value: "30", label: "Dans 30 jours" },
  { value: "date", label: "À une date" },
  { value: "never", label: "Jamais" },
];

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

/** The address of a link as it goes in a message: the app's own origin, so it works behind any proxy or tunnel. */
export function linkUrl(link: ShareLink): string {
  return `${window.location.origin}${linkPath(link.token)}`;
}

const isLive = (link: ShareLink) => link.status === "active" && !link.expired;

/** The page's links (`GET /api/pages/:id/links`), loaded once and reloaded after each change. */
function usePageLinks(pageId: string): { links: ShareLink[]; reload: () => Promise<void> } {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const reload = useCallback(async () => {
    const res = await fetch(`/api/pages/${pageId}/links`);
    if (res.ok) setLinks((await res.json()) as ShareLink[]);
  }, [pageId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { links, reload };
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

/** The "Partager" button of the canvas header, with the number of active links; opens the page's links. */
export function SharePageButton({ pageId, pageTitle, project }: { pageId: string; pageTitle: string; project: Project | null }) {
  const { links, reload } = usePageLinks(pageId);
  const [open, setOpen] = useState(false);
  const active = links.filter(isLive).length;
  return (
    <>
      <Button className={styles.shareButton} onClick={() => setOpen(true)}>
        <span className={styles.shareIcon}>
          <LinkIcon />
        </span>
        Partager
        <span className={styles.count} title={`${active} ${active > 1 ? "liens actifs" : "lien actif"}`}>
          {active}
        </span>
      </Button>
      {open && (
        <PageSharingDialog
          pageId={pageId}
          pageTitle={pageTitle}
          project={project}
          links={links}
          reload={reload}
          onClose={() => {
            setOpen(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

type Step = { name: "list" } | { name: "create" } | { name: "edit"; link: ShareLink } | { name: "disable"; link: ShareLink };

function PageSharingDialog({ pageId, pageTitle, project, links, reload, onClose }: { pageId: string; pageTitle: string; project: Project | null; links: ShareLink[]; reload: () => Promise<void>; onClose: () => void }) {
  const me = useMe();
  const [step, setStep] = useState<Step>({ name: "list" });
  const [foldedOpen, setFoldedOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined);
  const live = links.filter(isLive);
  const folded = links.filter((link) => !isLive(link));

  async function copy(link: ShareLink) {
    await navigator.clipboard.writeText(linkUrl(link));
    setCopiedId(link.id);
    setTimeout(() => setCopiedId(undefined), 1500);
  }
  async function reactivate(link: ShareLink) {
    await fetch(`/api/links/${link.id}/reactivate`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    await reload();
  }
  const author = (link: ShareLink) => (link.createdBy?.id === me?.id ? "toi" : (link.createdBy?.name ?? "un membre"));

  if (step.name === "create" || step.name === "edit") {
    return <LinkFormDialog pageId={pageId} link={step.name === "edit" ? step.link : undefined} onClose={() => setStep({ name: "list" })} onDone={reload} onCloseAll={onClose} />;
  }
  if (step.name === "disable") {
    const link = step.link;
    return (
      <Dialog title={`Désactiver « ${link.name} » ?`} width={460} alert onClose={() => setStep({ name: "list" })}>
        <p className={styles.text}>
          {link.deviceCount === 0 ? "Aucun appareil ne l'a ouvert pour l'instant." : `${link.deviceCount > 1 ? `Les ${link.deviceCount} appareils` : "L'appareil"} qui l'${link.deviceCount > 1 ? "ont" : "a"} ouvert perd${link.deviceCount > 1 ? "ent" : ""} l'accès tout de suite : ${link.deviceCount > 1 ? "ils voient" : "il voit"} « Ce lien ne marche plus ».`}
          {link.level !== "read" && " Leurs commentaires restent sur la page, signés de leur nom."}
        </p>
        <p className={styles.text}>Tu pourras le réactiver plus tard : la même adresse remarchera.</p>
        <DialogActions>
          <Button size="lg" onClick={() => setStep({ name: "list" })}>
            Annuler
          </Button>
          <Button
            size="lg"
            className={styles.dangerFill}
            onClick={async () => {
              await fetch(`/api/links/${link.id}/disable`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
              await reload();
              setStep({ name: "list" });
            }}
          >
            Désactiver le lien
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  const row = (link: ShareLink, dim: boolean) => (
    <div key={link.id} className={sharing.row} data-testid="link-row">
      {link.kind === "personal" ? (
        <Avatar initials={link.name.charAt(0).toUpperCase()} muted />
      ) : (
        <span className={sharing.icon} aria-hidden="true">
          <LinkIcon />
        </span>
      )}
      <div className={sharing.main}>
        <strong className={styles.rowTitle}>
          {link.name}
          <StatusBadge tone="neutral" size="sm" inline>
            {LEVEL_LABEL[link.level]}
          </StatusBadge>
        </strong>
        <span>{dim ? disabledLine(link, author) : liveLine(link, author(link))}</span>
      </div>
      <div className={styles.actions}>
        {isLive(link) && (
          <Button size="sm" onClick={() => void copy(link)}>
            {copiedId === link.id ? "Copié" : "Copier"}
          </Button>
        )}
        {link.canManage && (isLive(link) || link.expired) && (
          <Button size="sm" variant="ghost" onClick={() => setStep({ name: "edit", link })}>
            Modifier
          </Button>
        )}
        {link.canManage && isLive(link) && (
          <Button size="sm" variant="ghost" className={styles.danger} onClick={() => setStep({ name: "disable", link })}>
            Désactiver
          </Button>
        )}
        {link.canManage && link.status === "disabled" && (
          <Button size="sm" onClick={() => void reactivate(link)}>
            Réactiver
          </Button>
        )}
      </div>
    </div>
  );

  const privateProject = project?.visibility === "private";
  // On a Privé project only its creator and the admins create links; with no accounts (no `me`) everyone does.
  const mayCreate = !privateProject || !me || me.account?.role === "admin" || project?.createdBy?.id === me.id;
  return (
    <Dialog title={`Partager « ${pageTitle} »`} width={640} gap={24} onClose={onClose}>
      {project && (
        <section className={sharing.section}>
          <div className={sharing.sectionHead}>
            <h3 className={sharing.sectionTitle}>{privateProject ? "Privé" : "Équipe"}</h3>
          </div>
          <p className={sharing.text}>
            {project.title} est un projet <strong>{privateProject ? "Privé" : "Équipe"}</strong> :{" "}
            {privateProject ? "seuls son créateur, les admins et les membres ajoutés y ont accès" : "tous les membres y ont accès en Écriture"}. Les droits des membres se règlent sur le projet :{" "}
            <a className={styles.link} href={routeHref({ name: "project", projectId: project.id })} onClick={onClose}>
              Partager le projet
            </a>
            .
          </p>
        </section>
      )}
      <section className={sharing.section}>
        <div className={sharing.sectionHead}>
          <h3 className={sharing.sectionTitle}>Liens de partage</h3>
          {mayCreate && (
            <Button size="sm" variant="primary" onClick={() => setStep({ name: "create" })}>
              Créer un lien
            </Button>
          )}
        </div>
        <p className={sharing.text}>Pour un client ou un freelance, sans compte. Un lien ne donne accès qu'à cette page.</p>
        {privateProject && <p className={sharing.text}>{mayCreate ? "Sur un projet privé, seuls toi et les admins créez des liens." : "Sur un projet privé, seuls son créateur et les admins créent des liens."}</p>}
        {links.length === 0 ? (
          <div className={styles.empty}>
            Aucun lien sur cette page.
            <br />
            Crée-en un par personne (« pour Alix ») ou un pour tout un groupe (« Client HAIDF »).
          </div>
        ) : (
          live.length > 0 && <div className={sharing.list}>{live.map((link) => row(link, false))}</div>
        )}
        {folded.length > 0 && (
          <>
            <button type="button" className={styles.more} aria-expanded={foldedOpen} onClick={() => setFoldedOpen(!foldedOpen)}>
              {folded.length} {folded.length > 1 ? "liens désactivés ou expirés" : "lien désactivé ou expiré"}
              <span aria-hidden="true" className={cx(styles.moreChevron, foldedOpen && styles.moreChevronOpen)}>
                ⌄
              </span>
            </button>
            {foldedOpen && <div className={cx(sharing.list, styles.off)}>{folded.map((link) => row(link, true))}</div>}
          </>
        )}
      </section>
    </Dialog>
  );
}

function liveLine(link: ShareLink, author: string): string {
  const kind = link.kind === "generic" ? "Tout le monde avec le lien" : "Pour une personne";
  const expiry = link.expiresAt ? `expire le ${shortDate(link.expiresAt)}` : "sans expiration";
  const opened = link.lastOpenedAt ? `ouvert ${relativeTime(link.lastOpenedAt)}` : "jamais ouvert";
  return `${kind} · créé par ${author} · ${expiry} · ${opened} · ${link.deviceCount} ${link.deviceCount > 1 ? "appareils" : "appareil"}`;
}

function disabledLine(link: ShareLink, author: (link: ShareLink) => string): string {
  if (link.status === "active") return `Expiré le ${shortDate(link.expiresAt!)}`;
  const by = link.disabledBy ? ` par ${link.disabledBy.id === link.createdBy?.id ? author(link) : link.disabledBy.name}` : "";
  return `Désactivé le ${shortDate(link.disabledAt!)}${by}`;
}

function expiryOf(choice: ExpiryChoice, date: string): string | null {
  if (choice === "never") return null;
  if (choice === "date") return new Date(`${date}T23:59:59`).toISOString();
  return new Date(Date.now() + Number(choice) * DAY_MS).toISOString();
}

/** "Créer un lien" (and "Modifier"): who it is for, its name, level and expiry; then the address to copy. */
function LinkFormDialog({ pageId, link, onClose, onDone, onCloseAll }: { pageId: string; link?: ShareLink; onClose: () => void; onDone: () => Promise<void>; onCloseAll: () => void }) {
  const editing = link !== undefined;
  const [kind, setKind] = useState<LinkKind>(link?.kind ?? "personal");
  const [name, setName] = useState(link?.name ?? "");
  const [level, setLevel] = useState<AccessLevel>(link?.level ?? "read");
  const [expiry, setExpiry] = useState<ExpiryChoice>(link ? (link.expiresAt ? "date" : "never") : "14");
  const [date, setDate] = useState(link?.expiresAt ? link.expiresAt.slice(0, 10) : new Date(Date.now() + 14 * DAY_MS).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<ShareLink | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return setError("Donne un nom au lien.");
    if (expiry === "date" && date === "") return setError("Choisis une date.");
    setBusy(true);
    const expiresAt = expiry === "date" && link?.expiresAt?.slice(0, 10) === date ? link.expiresAt : expiryOf(expiry, date);
    const res = editing
      ? await fetch(`/api/links/${link.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name, level, expiresAt }) })
      : await fetch(`/api/pages/${pageId}/links`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind, name, level, expiresAt } satisfies CreateLinkRequest) });
    setBusy(false);
    if (!res.ok) return setError("Le lien n'a pas pu être enregistré.");
    await onDone();
    if (editing) return onClose();
    setCreated((await res.json()) as ShareLink);
  }

  async function copy(done: ShareLink) {
    await navigator.clipboard.writeText(linkUrl(done));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (created) {
    const url = linkUrl(created);
    return (
      <Dialog title="Créer un lien" width={540} onClose={onCloseAll}>
        <div role="status" className={invite.ok}>
          Lien créé pour {created.name}, en {LEVEL_LABEL[created.level]}, {created.expiresAt ? `jusqu'au ${shortDate(created.expiresAt).replace(/\.$/, "")}` : "sans expiration"}.
        </div>
        <Field label="Lien" hint={created.kind === "personal" ? `Quiconque a ce lien agit au nom de ${created.name} : envoie-le-lui directement.` : "Quiconque a ce lien voit la page : envoie-le au groupe concerné."}>
          <span className={invite.linkbox}>
            <TextInput className={invite.linkInput} readOnly value={url} onFocus={(e) => e.target.select()} />
            <Button size="lg" onClick={() => void copy(created)}>
              {copied ? "Copié" : "Copier"}
            </Button>
          </span>
        </Field>
        <DialogActions>
          <Button variant="primary" size="lg" onClick={onCloseAll}>
            Terminé
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog title={editing ? "Modifier le lien" : "Créer un lien"} width={540} onClose={onClose}>
      <form className={invite.form} onSubmit={submit}>
        {!editing && (
          <fieldset className={invite.fieldset}>
            <legend className={invite.legend}>Pour qui</legend>
            <SegmentedControl<LinkKind> size="md" ariaLabel="Pour qui" options={KIND_OPTIONS} value={kind} onChange={setKind} />
          </fieldset>
        )}
        <Field
          label={kind === "personal" ? "Son nom" : "Nom du lien"}
          hint={kind === "personal" ? `Ses commentaires et ses changements seront signés « ${name.trim() || "Alix"} ».` : "Visible de l'équipe, pas des visiteurs. À son premier commentaire, chaque visiteur donne son nom."}
          className={invite.field}
        >
          <TextInput name="name" value={name} placeholder={kind === "personal" ? "Alix" : "Client HAIDF"} aria-invalid={error !== undefined && name.trim() === ""} onChange={(e) => { setName(e.target.value); setError(undefined); }} />
        </Field>
        <fieldset className={invite.fieldset}>
          <legend className={invite.legend}>Niveau</legend>
          <div className={invite.roles}>
            {OFFERED_LEVELS.map((option) => (
              <label key={option} className={cx(invite.role, level === option && invite.roleOn)}>
                <input type="radio" name="level" className={invite.radio} checked={level === option} onChange={() => setLevel(option)} />
                <span className={invite.roleText}>
                  <strong>{LEVEL_LABEL[option]}</strong>
                  <span>{LEVEL_DESCRIPTION[option]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className={styles.two}>
          <Field label="Expiration">
            <Select aria-label="Expiration" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </Field>
          {expiry === "date" && (
            <Field label="Date">
              <TextInput type="date" aria-label="Date d'expiration" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
            </Field>
          )}
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <DialogActions>
          <Button size="lg" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" variant="accent" size="lg" disabled={busy}>
            {editing ? "Enregistrer" : "Créer le lien"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
