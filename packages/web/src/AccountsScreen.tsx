import { useCallback, useEffect, useState } from "react";
import { ACCOUNTS_PATH, INVITATIONS_PATH, type AccountEntry, type AccountRole, type AccountsResponse, type InvitationEntry, type PasswordLinkEntry } from "@redline/shared";
import { Avatar } from "./Avatar.js";
import { InviteDialog, invitationLink } from "./InviteDialog.js";
import { relativeTime } from "./relativeTime.js";
import { DeactivateDialog, PasswordLinkDialog, RoleDialog, changeRole, reactivate } from "./AccountDialogs.js";
import { Button, PageContent, PageHeader, Select, StatusBadge, cx } from "./ui/index.js";
import { useMe } from "./useMe.js";
import styles from "./AccountsScreen.module.css";

const plural = (count: number, one: string, many: string) => `${count} ${count <= 1 ? one : many}`;
const dateShort = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

interface RowActions {
  onRole: (role: AccountRole) => void;
  onPasswordLink: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}

function AccountRow({ account, isMe, soleAdmin, actions }: { account: AccountEntry; isMe: boolean; soleAdmin: boolean; actions: RowActions }) {
  const off = account.status === "deactivated";
  const roleLabel = account.role === "admin" ? "Admin" : "Membre";
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
        {isMe || off ? (
          <StatusBadge tone="neutral" inline>{roleLabel}</StatusBadge>
        ) : (
          <Select size="sm" className={styles.role} aria-label={`Rôle d'${account.name}`} value={account.role} onChange={(e) => actions.onRole(e.target.value as AccountRole)}>
            <option value="member">Membre</option>
            <option value="admin">Admin</option>
          </Select>
        )}
        {soleAdmin && <div className={styles.hint}>Seul admin : il en faut au moins un</div>}
      </td>
      <td className={styles.muted}>{account.lastSignInAt ? relativeTime(account.lastSignInAt) : "jamais"}</td>
      <td>
        <StatusBadge tone={off ? "neutral" : "success"} inline>{off ? "Désactivé" : "Actif"}</StatusBadge>
      </td>
      <td>
        <div className={styles.actions}>
          {off && <Button variant="ghost" size="sm" onClick={actions.onReactivate}>Réactiver</Button>}
          {!off && !isMe && (
            <>
              <Button variant="ghost" size="sm" onClick={actions.onPasswordLink}>Lien mot de passe</Button>
              <Button variant="ghost" size="sm" className={styles.danger} onClick={actions.onDeactivate}>Désactiver</Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function InvitationRow({ invitation, onCancel }: { invitation: InvitationEntry; onCancel: () => void }) {
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
            <span>invité par {invitation.invitedBy} le {dateShort(invitation.createdAt)}</span>
          </div>
        </div>
      </td>
      <td>
        <StatusBadge tone="neutral" inline>{invitation.role === "admin" ? "Admin" : "Membre"}</StatusBadge>
      </td>
      <td className={styles.muted}>jamais</td>
      <td>
        <StatusBadge tone="warning" inline>Invitation · expire le {dateShort(invitation.expiresAt)}</StatusBadge>
      </td>
      <td>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={() => void copy()}>{copied ? "Lien copié" : "Copier le lien"}</Button>
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
  const [promoting, setPromoting] = useState<AccountEntry | undefined>(undefined);
  const [deactivating, setDeactivating] = useState<AccountEntry | undefined>(undefined);
  const [passwordLink, setPasswordLink] = useState<{ account: AccountEntry; link: PasswordLinkEntry } | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

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

  async function setRole(account: AccountEntry, role: AccountRole) {
    setNotice(await changeRole(account, role));
    await load();
  }

  async function openPasswordLink(account: AccountEntry) {
    const res = await fetch(`${ACCOUNTS_PATH}/${account.id}/password-link`, { method: "POST" });
    if (res.ok) setPasswordLink({ account, link: (await res.json()) as PasswordLinkEntry });
  }

  if (!data) return null;
  const activeAdmins = data.accounts.filter((a) => a.role === "admin" && a.status === "active");
  return (
    <PageContent>
      <PageHeader
        title="Comptes"
        subtitle={`${plural(data.accounts.length, "compte", "comptes")} · ${plural(data.invitations.length, "invitation en attente", "invitations en attente")} · connexion Redline`}
        actions={<Button variant="accent" size="lg" onClick={() => setInviting(true)}>Inviter quelqu'un</Button>}
      />
      {notice && <div role="alert" className={styles.notice}>{notice}</div>}
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
            <AccountRow key={account.id} account={account} isMe={account.id === me?.id} soleAdmin={activeAdmins.length === 1 && activeAdmins[0].id === account.id}
              actions={{
                onRole: (role) => (role === "admin" ? setPromoting(account) : void setRole(account, role)),
                onPasswordLink: () => void openPasswordLink(account),
                onDeactivate: () => setDeactivating(account),
                onReactivate: () => void reactivate(account).then(load),
              }}
            />
          ))}
          {data.invitations.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} onCancel={() => void cancel(invitation)} />
          ))}
        </tbody>
      </table>
      {promoting && (
        <RoleDialog
          account={promoting}
          onClose={() => setPromoting(undefined)}
          onConfirm={() => {
            void setRole(promoting, "admin");
            setPromoting(undefined);
          }}
        />
      )}
      {deactivating && (
        <DeactivateDialog
          account={deactivating}
          onClose={() => setDeactivating(undefined)}
          onDone={() => {
            setDeactivating(undefined);
            void load();
          }}
        />
      )}
      {passwordLink && <PasswordLinkDialog account={passwordLink.account} link={passwordLink.link} onClose={() => setPasswordLink(undefined)} />}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onInvited={() => void load()} />}
    </PageContent>
  );
}
