import { useEffect, useState, type FormEvent } from "react";
import { MY_ACCOUNT_PATH, MY_LINKS_PATH, MY_PASSWORD_PATH, type MyLink } from "@redline/shared";
import { shortDate } from "./PageSharing.js";
import { LEVEL_LABEL } from "./ProjectSharingDialog.js";
import { routeHref } from "./router.js";
import { Button, Card, Field, PageContent, PageHeader, TextInput } from "./ui/index.js";
import { useMe, useSession } from "./useMe.js";
import styles from "./MyAccountScreen.module.css";

const MIN_PASSWORD_LENGTH = 8;
const post = (method: string, path: string, body: unknown) => fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function ProfilePanel({ name: initialName }: { name: string }) {
  const { reload } = useSession();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const res = await post("PATCH", MY_ACCOUNT_PATH, { name });
    if (res.ok) {
      await reload();
      setSaved(true);
    }
    setBusy(false);
  }

  return (
    <Card as="section" aria-label="Profil" className={styles.panel}>
      <h2 className={styles.panelTitle}>Profil</h2>
      <form className={styles.form} onSubmit={submit}>
        <Field quiet label="Nom" hint={saved ? "Enregistré." : undefined}>
          <TextInput size="form" name="name" autoComplete="name" value={name} required onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        </Field>
        <div className={styles.end}>
          <Button type="submit" variant="primary" disabled={busy}>Enregistrer</Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordPanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<{ field: "current" | "next"; text: string } | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(false);
    if (next.length < MIN_PASSWORD_LENGTH) return setError({ field: "next", text: `${MIN_PASSWORD_LENGTH} caractères au moins.` });
    setBusy(true);
    const res = await post("POST", MY_PASSWORD_PATH, { currentPassword: current, newPassword: next });
    setBusy(false);
    if (res.ok) {
      setCurrent("");
      setNext("");
      setError(undefined);
      return setDone(true);
    }
    const body = (await res.json()) as { code?: string };
    setError(body.code === "wrong-password" ? { field: "current", text: "Le mot de passe actuel n'est pas le bon." } : { field: "next", text: "Le mot de passe n'a pas pu être changé." });
  }

  return (
    <Card as="section" aria-label="Mot de passe" className={styles.panel}>
      <h2 className={styles.panelTitle}>Mot de passe</h2>
      <form className={styles.form} onSubmit={submit}>
        <Field quiet label="Mot de passe actuel" hint={error?.field === "current" ? error.text : undefined}>
          <TextInput size="form" type="password" name="current-password" autoComplete="current-password" value={current} required aria-invalid={error?.field === "current"} onChange={(e) => { setCurrent(e.target.value); setError(undefined); }} />
        </Field>
        <Field quiet label="Nouveau mot de passe" hint={error?.field === "next" ? error.text : "8 caractères au moins. Tes autres appareils seront déconnectés."}>
          <TextInput size="form" type="password" name="new-password" autoComplete="new-password" value={next} required aria-invalid={error?.field === "next"} onChange={(e) => { setNext(e.target.value); setError(undefined); setDone(false); }} />
        </Field>
        <div className={styles.end}>
          {done && <span role="status" className={styles.done}>Mot de passe changé.</span>}
          <Button type="submit" variant="primary" disabled={busy}>Changer le mot de passe</Button>
        </div>
      </form>
    </Card>
  );
}

const stateOf = ({ link }: MyLink): string => {
  if (link.status === "disabled") return "désactivé";
  if (link.expired) return "expiré";
  return link.expiresAt ? `expire le ${shortDate(link.expiresAt)}` : "sans expiration";
};

/** Where a link leads and how: "Radio HAIDF › V1 · Commentaire · expire le 21 nov.". */
const detailsOf = (mine: MyLink): string => `${mine.pageTitle ? `${mine.projectTitle} › ${mine.pageTitle}` : `${mine.projectTitle} (projet)`} · ${LEVEL_LABEL[mine.link.level]} · ${stateOf(mine)}`;

/** The share links the account created, to find and open the page they lead to. */
function LinksPanel() {
  const [links, setLinks] = useState<MyLink[] | undefined>(undefined);
  useEffect(() => {
    void fetch(MY_LINKS_PATH).then(async (res) => setLinks(res.ok ? ((await res.json()) as MyLink[]) : []));
  }, []);
  if (links === undefined) return null;
  const active = links.filter(({ link }) => link.status === "active" && !link.expired).length;
  return (
    <Card as="section" aria-label="Mes liens de partage" className={styles.panel}>
      <h2 className={styles.panelTitle}>
        Mes liens de partage · {active} {active > 1 ? "actifs" : "actif"}
      </h2>
      {links.length === 0 ? (
        <p className={styles.empty}>Tu n'as créé aucun lien de partage.</p>
      ) : (
        <div>
          {links.map((mine) => (
            <div key={mine.link.id} className={styles.linkRow} data-testid="my-link">
              <div className={styles.linkText}>
                <strong>{mine.link.name}</strong>
                <span>{detailsOf(mine)}</span>
              </div>
              <Button size="sm" onClick={() => (window.location.hash = routeHref(mine.pageId ? { name: "page", pageId: mine.pageId } : { name: "project", projectId: mine.projectId }))}>
                Ouvrir
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** "Mon compte" (account menu): the signed-in account changes its name and its password. */
export function MyAccountScreen() {
  const me = useMe();
  if (!me?.account) return null;
  return (
    <PageContent className={styles.content}>
      <PageHeader title="Mon compte" subtitle={`${me.email} · ${me.account.role === "admin" ? "Admin" : "Membre"}`} />
      <ProfilePanel key={me.name} name={me.name} />
      <PasswordPanel />
      <LinksPanel />
    </PageContent>
  );
}
