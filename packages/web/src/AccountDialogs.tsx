import { useState } from "react";
import { ACCOUNTS_PATH, type AccountEntry, type DeactivateRequest, type PasswordLinkEntry } from "@redline/shared";
import { Button, Dialog, DialogActions, Field, TextInput } from "./ui/index.js";
import styles from "./AccountDialogs.module.css";

/** Where a person opens their password link: the app's own address, so it works behind any proxy or tunnel. */
export function passwordLinkUrl(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/mot-de-passe/${token}`;
}

const act = (account: AccountEntry, action: string, method = "POST", body?: unknown) =>
  fetch(`${ACCOUNTS_PATH}/${account.id}${action}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Sets the role of an account; the server refuses to lower the last active admin. Returns the error text, if any. */
export async function changeRole(account: AccountEntry, role: "admin" | "member"): Promise<string | undefined> {
  const res = await act(account, "", "PATCH", { role });
  return res.ok ? undefined : ((await res.json()) as { error: string }).error;
}

export async function reactivate(account: AccountEntry): Promise<void> {
  await act(account, "/reactivate");
}

/** Promotion asks first: an admin sees every project, even private ones, and manages the accounts. */
export function RoleDialog({ account, onClose, onConfirm }: { account: AccountEntry; onClose: () => void; onConfirm: () => void }) {
  const first = account.name.split(/\s+/)[0] || account.name;
  return (
    <Dialog title={`Passer ${account.name} admin ?`} onClose={onClose} width={480}>
      <p className={styles.text}>{first} verra tous les projets, même privés, et pourra gérer les comptes : inviter, désactiver, changer les rôles.</p>
      <DialogActions>
        <Button onClick={onClose}>Annuler</Button>
        <Button variant="accent" onClick={onConfirm}>Passer admin</Button>
      </DialogActions>
    </Dialog>
  );
}

/** What deactivating an account does to its projects: they pass to the admin who deactivates. */
function projectsLine(titles: string[]): string | undefined {
  if (titles.length === 0) return undefined;
  return titles.length === 1 ? `Son projet « ${titles[0]} » passe à toi.` : `Ses ${titles.length} projets passent à toi.`;
}

export function DeactivateDialog({ account, onClose, onDone }: { account: AccountEntry; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const first = account.name.split(/\s+/)[0] || account.name;
  const projects = projectsLine(account.ownedProjects);
  const [disableLinks, setDisableLinks] = useState(false);
  const links = account.linkCount === 1 ? "lien de partage" : "liens de partage";

  async function confirm() {
    setBusy(true);
    const res = await act(account, "/deactivate", "POST", { disableLinks } satisfies DeactivateRequest);
    if (res.ok) return onDone();
    setError(((await res.json()) as { error: string }).error);
    setBusy(false);
  }

  return (
    <Dialog title={`Désactiver ${account.name} ?`} onClose={onClose} width={480} alert>
      <p className={styles.text}>{first} ne pourra plus se connecter. Son nom reste sur ses messages et ses versions.</p>
      <ul className={styles.list}>
        {projects && <li>{projects}</li>}
        <li>Son jeton d'agent est révoqué : son agent est déconnecté.</li>
        {account.linkCount > 0 && <li>{account.linkCount === 1 ? "Son lien de partage continue" : `Ses ${account.linkCount} liens de partage continuent`} de marcher.</li>}
      </ul>
      {account.linkCount > 0 && (
        <label className={styles.check}>
          <input type="checkbox" checked={disableLinks} onChange={(e) => setDisableLinks(e.target.checked)} />
          Désactiver aussi {account.linkCount === 1 ? "son" : `ses ${account.linkCount}`} {links}
        </label>
      )}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <DialogActions>
        <Button onClick={onClose}>Annuler</Button>
        <Button className={styles.dangerFill} disabled={busy} onClick={() => void confirm()}>Désactiver</Button>
      </DialogActions>
    </Dialog>
  );
}

/** A fresh password link for an account, to copy: it works once, for 24 hours. */
export function PasswordLinkDialog({ account, link, onClose }: { account: AccountEntry; link: PasswordLinkEntry; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = passwordLinkUrl(link.token);
  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <Dialog title="Lien de mot de passe" onClose={onClose} width={480}>
      <p className={styles.text}>
        Envoie ce lien à {account.name}, qui y choisit un nouveau mot de passe. Il marche une fois, pendant 24 heures, et déconnecte ses autres appareils.
      </p>
      <Field label={`Lien pour ${account.name}`}>
        <span className={styles.linkbox}>
          <TextInput size="form" className={styles.linkInput} readOnly value={url} onFocus={(e) => e.target.select()} />
          <Button size="lg" onClick={() => void copy()}>{copied ? "Copié" : "Copier"}</Button>
        </span>
      </Field>
      <DialogActions>
        <Button variant="primary" onClick={onClose}>Terminé</Button>
      </DialogActions>
    </Dialog>
  );
}
