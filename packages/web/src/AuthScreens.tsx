import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SESSION_PATH, SETUP_PATH } from "@redline/shared";
import { Button, Field, Logo, TextInput, cx } from "./ui/index.js";
import { useDocumentTitle } from "./documentTitle.js";
import { useSession } from "./useMe.js";
import styles from "./AuthScreens.module.css";

const MIN_PASSWORD_LENGTH = 8;

/** Messages for the answers of the setup call (the server's own messages are English, for the logs and the CLI). */
const SETUP_ERRORS: Record<string, string> = {
  "password-too-short": `${MIN_PASSWORD_LENGTH} caractères au moins.`,
  "invalid-email": "Cet email n'a pas l'air valide.",
};

function AuthCard({ wide, footer, children }: { wide?: boolean; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <main className={cx(styles.card, wide && styles.wide)}>
        <Logo />
        {children}
      </main>
      {footer}
    </div>
  );
}

function Notice({ tone, role, children }: { tone: "danger" | "neutral"; role: "alert" | "status"; children: ReactNode }) {
  return (
    <div role={role} className={cx(styles.notice, styles[tone])}>
      {children}
    </div>
  );
}

type SignInState = "idle" | "wrong" | "locked";

export function SignInScreen() {
  useDocumentTitle("Connexion");
  const { justSignedOut, reload } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<SignInState>("idle");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const res = await fetch(SESSION_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (res.ok) {
      await reload();
      return;
    }
    setState(res.status === 429 ? "locked" : "wrong");
    setBusy(false);
  }

  const locked = state === "locked";
  return (
    <AuthCard footer={<p className={styles.foot}>{window.location.host}</p>}>
      <div className={styles.head}>
        <h1>Se connecter</h1>
        <p>Pas encore de compte ? Demande une invitation à un admin de cette instance.</p>
      </div>
      {state === "wrong" && <Notice tone="danger" role="alert">Email ou mot de passe incorrect.</Notice>}
      {locked && (
        <Notice tone="danger" role="alert">
          Trop d'essais. Réessaie dans 15 minutes, ou demande à un admin un lien pour changer ton mot de passe.
        </Notice>
      )}
      {justSignedOut && state === "idle" && <Notice tone="neutral" role="status">Tu es déconnecté.</Notice>}
      <form className={styles.form} onSubmit={submit}>
        <Field label="Email" className={styles.field}>
          <TextInput className={styles.input} type="email" name="email" autoComplete="username" value={email} required onChange={(e) => { setEmail(e.target.value); if (locked) setState("idle"); }} />
        </Field>
        <Field label="Mot de passe" className={styles.field}>
          <TextInput className={styles.input} type="password" name="password" autoComplete="current-password" value={password} required aria-invalid={state === "wrong"} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="accent" size="lg" className={styles.submit} disabled={busy || locked}>
          Se connecter
        </Button>
      </form>
      <p className={styles.hint}>Mot de passe oublié : demande à un admin un lien pour en choisir un nouveau.</p>
    </AuthCard>
  );
}

/** The "Premier admin" screen, opened from the setup link written to the server logs: `#/setup/<token>`. */
export function SetupScreen({ token }: { token: string }) {
  useDocumentTitle("Premier admin");
  const { reload } = useSession();
  const [valid, setValid] = useState<boolean | undefined>(undefined);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${SETUP_PATH}?token=${encodeURIComponent(token)}`).then((res) => setValid(res.ok));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) return setError(SETUP_ERRORS["password-too-short"]);
    setBusy(true);
    const res = await fetch(SETUP_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name, email, password }) });
    if (res.ok) {
      window.location.hash = "#/";
      await reload();
      return;
    }
    const body = (await res.json()) as { code?: string };
    if (body.code === "invalid-link") return setValid(false);
    setError(SETUP_ERRORS[body.code ?? ""] ?? "Le compte n'a pas pu être créé.");
    setBusy(false);
  }

  if (valid === undefined) return null;
  if (!valid) {
    return (
      <AuthCard wide>
        <div className={styles.head}>
          <h1>Lien déjà utilisé</h1>
          <p>Le compte admin de cette instance existe déjà : connecte-toi avec lui. Si tu as perdu son mot de passe, cette commande sur le serveur écrit dans les logs un lien pour en choisir un nouveau :</p>
        </div>
        <pre className={styles.command}>docker compose exec redline redline-server reset-admin</pre>
        <Button variant="secondary" size="lg" className={styles.link} onClick={() => { window.location.hash = "#/"; void reload(); }}>
          Aller à la connexion
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard wide>
      <div className={styles.head}>
        <h1>Créer le compte admin</h1>
        <p>Cette instance n'a encore aucun compte. Tu as ouvert le lien d'installation écrit dans les logs : ce compte sera le premier admin, et les projets déjà là lui appartiendront, visibles de toute l'équipe.</p>
      </div>
      <form className={styles.form} onSubmit={submit}>
        <Field label="Nom" className={styles.field}>
          <TextInput className={styles.input} name="name" autoComplete="name" value={name} required onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" className={styles.field}>
          <TextInput className={styles.input} type="email" name="email" autoComplete="username" value={email} required onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Mot de passe" hint={error ?? "8 caractères au moins."} className={styles.field}>
          <TextInput className={styles.input} type="password" name="password" autoComplete="new-password" value={password} required aria-invalid={error !== undefined} onChange={(e) => { setPassword(e.target.value); setError(undefined); }} />
        </Field>
        <Button type="submit" variant="accent" size="lg" className={styles.submit} disabled={busy}>
          Créer le compte et entrer
        </Button>
      </form>
    </AuthCard>
  );
}
