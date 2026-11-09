import { useCallback, useEffect, useState } from "react";
import { ACCOUNTS_PATH, INVITATIONS_PATH, type AccountEntry, type AccountsResponse, type InvitationEntry } from "@redline/shared";
import { Avatar } from "./Avatar.js";
import { InviteDialog, invitationLink } from "./InviteDialog.js";
import { relativeTime } from "./relativeTime.js";
import { Button, PageContent, PageHeader, StatusBadge, cx } from "./ui/index.js";
import { useMe } from "./useMe.js";
import styles from "./AccountsScreen.module.css";

const plural = (count: number, one: string, many: string) => `${count} ${count <= 1 ? one : many}`;
const dateShort = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

function AccountRow({ account, isMe, soleAdmin }: { account: AccountEntry; isMe: boolean; soleAdmin: boolean }) {
  const off = account.status === "deactivated";
  return (
    <tr className={cx(off && styles.off)}>
      <td>
        <div className={styles.who}>
          <Avatar initials={account.initials} muted={off} />
          <div className={styles.whoText}>
            <strong>{isMe ? `${account.name} (toi)` : account.name}</strong>
            <span>{account.email}</span>
          </div>
        </div>
      </td>
      <td>
        <StatusBadge tone="neutral" inline>{account.role === "admin" ? "Admin" : "Membre"}</StatusBadge>
        {soleAdmin && <div className={styles.hint}>Seul admin : il en faut au moins un</div>}
      </td>
      <td className={styles.muted}>{account.lastSignInAt ? relativeTime(account.lastSignInAt) : "jamais"}</td>
      <td>
        <StatusBadge tone={off ? "neutral" : "success"} inline>{off ? "Désactivé" : "Actif"}</StatusBadge>
      </td>
      <td />
    </tr>
  );
}

function InvitationRow({ invitation, sso, onCancel }: { invitation: InvitationEntry; sso: boolean; onCancel: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(invitationLink(invitation.token));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <tr>
      <td>
        <div className={styles.who}>
          <Avatar initials="?" muted />
          <div className={styles.whoText}>
            <strong>{invitation.email}</strong>
            <span>{sso ? "ajouté" : "invité"} par {invitation.invitedBy} le {dateShort(invitation.createdAt)}</span>
          </div>
        </div>
      </td>
      <td>
        <StatusBadge tone="neutral" inline>{invitation.role === "admin" ? "Admin" : "Membre"}</StatusBadge>
      </td>
      <td className={styles.muted}>jamais</td>
      <td>
        <StatusBadge tone="warning" inline>{sso ? "En attente de sa première connexion" : `Invitation · expire le ${dateShort(invitation.expiresAt!)}`}</StatusBadge>
      </td>
      <td>
        <div className={styles.actions}>
          {!sso && <Button variant="ghost" size="sm" onClick={() => void copy()}>{copied ? "Lien copié" : "Copier le lien"}</Button>}
          <Button variant="ghost" size="sm" className={styles.danger} onClick={onCancel}>Annuler</Button>
        </div>
      </td>
    </tr>
  );
}

/** "Comptes": the accounts of the instance and the invitations still open. Admins only (the route checks). */
export function AccountsScreen() {
  const me = useMe();
  const [data, setData] = useState<AccountsResponse | undefined>(undefined);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    setData((await (await fetch(ACCOUNTS_PATH)).json()) as AccountsResponse);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(invitation: InvitationEntry) {
    await fetch(`${INVITATIONS_PATH}/${invitation.id}`, { method: "DELETE" });
    await load();
  }

  if (!data) return null;
  const activeAdmins = data.accounts.filter((a) => a.role === "admin" && a.status === "active");
  return (
    <PageContent>
      <PageHeader
        title="Comptes"
        subtitle={
          data.sso
            ? `${plural(data.accounts.length, "compte", "comptes")} · ${plural(data.invitations.length, "ajout en attente", "ajouts en attente")} · connexion par Authelia`
            : `${plural(data.accounts.length, "compte", "comptes")} · ${plural(data.invitations.length, "invitation en attente", "invitations en attente")} · connexion Redline`
        }
        actions={<Button variant="accent" size="lg" onClick={() => setInviting(true)}>{data.sso ? "Ajouter quelqu'un" : "Inviter quelqu'un"}</Button>}
      />
      {data.sso && (
        <p className={styles.sso}>
          Connexion par Authelia : chacun entre avec son compte Authelia, et Redline le reconnaît à son e-mail. Les rôles et l'accès se gèrent ici, les mots de passe dans Authelia. Une personne qui n'est pas dans cette liste n'entre pas.
        </p>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Personne</th>
            <th>Rôle</th>
            <th>Dernière connexion</th>
            <th>État</th>
            <th><span className={styles.srOnly}>Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((account) => (
            <AccountRow key={account.id} account={account} isMe={account.id === me?.id} soleAdmin={activeAdmins.length === 1 && activeAdmins[0].id === account.id} />
          ))}
          {data.invitations.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} sso={data.sso} onCancel={() => void cancel(invitation)} />
          ))}
        </tbody>
      </table>
      {inviting && <InviteDialog sso={data.sso} onClose={() => setInviting(false)} onInvited={() => void load()} />}
    </PageContent>
  );
}
