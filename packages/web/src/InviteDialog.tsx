import { useState, type FormEvent } from "react";
import { INVITATIONS_PATH, type AccountRole, type InvitationEntry } from "@redline/shared";
import { Button, Dialog, DialogActions, Field, TextInput, cx } from "./ui/index.js";
import styles from "./InviteDialog.module.css";

const ROLES: { role: AccountRole; title: string; description: string }[] = [
  { role: "member", title: "Membre", description: "Voit les projets Équipe et y travaille, crée ses projets." },
  { role: "admin", title: "Admin", description: "Voit tous les projets, même privés, et gère les comptes." },
];

const ERRORS: Record<string, string> = {
  "invalid-email": "Cet email n'a pas l'air valide.",
  "email-taken": "Cet email a déjà un compte.",
  "invitation-pending": "Cet email a déjà une invitation en attente : copie son lien depuis la liste.",
};

/** Where an invitee opens their invitation: the app's own address, so it works behind any proxy or tunnel. */
export function invitationLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/invitation/${token}`;
}

/** "Inviter quelqu'un": e-mail and role, then the link to copy (no e-mail is sent). */
export function InviteDialog({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AccountRole>("member");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<InvitationEntry | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const res = await fetch(INVITATIONS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, role }) });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json()) as { code?: string };
      return setError(ERRORS[body.code ?? ""] ?? "L'invitation n'a pas pu être créée.");
    }
    setCreated((await res.json()) as InvitationEntry);
    onInvited();
  }

  async function copy(link: string) {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (created) {
    const link = invitationLink(created.token);
    const until = new Date(created.expiresAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
    return (
      <Dialog title="Inviter quelqu'un" onClose={onClose} width={480}>
        <div role="status" className={styles.ok}>
          Invitation créée pour {created.email}, comme {created.role === "admin" ? "admin" : "membre"}. Le lien marche une fois, jusqu'au {until}.
        </div>
        <Field label="Lien d'invitation">
          <span className={styles.linkbox}>
            <TextInput className={styles.linkInput} readOnly value={link} onFocus={(e) => e.target.select()} />
            <Button size="lg" onClick={() => void copy(link)}>{copied ? "Copié" : "Copier"}</Button>
          </span>
        </Field>
        <p className={styles.hint}>Tu le retrouves dans Comptes tant qu'il n'a pas servi.</p>
        <DialogActions>
          <Button variant="primary" size="lg" onClick={onClose}>Terminé</Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog title="Inviter quelqu'un" onClose={onClose} width={480}>
      <form className={styles.form} onSubmit={submit}>
        <p className={styles.intro}>Redline n'envoie pas d'email : il crée un lien d'invitation que tu envoies toi-même (Mattermost, SMS…).</p>
        <Field label="Email" hint={error} className={styles.field}>
          <TextInput type="email" name="email" value={email} required aria-invalid={error !== undefined} onChange={(e) => { setEmail(e.target.value); setError(undefined); }} />
        </Field>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Rôle</legend>
          <div className={styles.roles}>
            {ROLES.map((option) => (
              <label key={option.role} className={cx(styles.role, role === option.role && styles.roleOn)}>
                <input type="radio" name="role" className={styles.radio} checked={role === option.role} onChange={() => setRole(option.role)} />
                <span className={styles.roleText}>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className={styles.hint}>Pour un client ou un freelance, pas de compte : partage-lui une page ou un projet par lien.</p>
        <DialogActions>
          <Button size="lg" onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="accent" size="lg" disabled={busy}>Créer le lien d'invitation</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
