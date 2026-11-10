import { useEffect, useState, type ReactNode } from "react";
import { NO_ACCESS_CODE, type NoAccessResponse } from "@redline/shared";
import { Button, Logo } from "./ui/index.js";
import { navigateTo } from "./router.js";
import { useDocumentTitle } from "./documentTitle.js";
import styles from "./NoAccess.module.css";

export const NO_ACCESS_EVENT = "redline:no-access";

/** Tells the app that the server refused a project to its viewer (the 403 that names the creator). */
export function reportNoAccess(refusal: NoAccessResponse): void {
  window.dispatchEvent(new CustomEvent<NoAccessResponse>(NO_ACCESS_EVENT, { detail: refusal }));
}

export function isNoAccess(body: unknown): body is NoAccessResponse {
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === NO_ACCESS_CODE;
}

/** "Pas d'accès à ce projet": shown in place of any screen the server refused, until the viewer goes elsewhere. */
export function NoAccessGate({ children }: { children: ReactNode }) {
  const [refusal, setRefusal] = useState<NoAccessResponse | null>(null);
  useEffect(() => {
    const onRefused = (event: Event) => setRefusal((event as CustomEvent<NoAccessResponse>).detail);
    const onNavigate = () => setRefusal(null);
    window.addEventListener(NO_ACCESS_EVENT, onRefused);
    window.addEventListener("hashchange", onNavigate);
    return () => {
      window.removeEventListener(NO_ACCESS_EVENT, onRefused);
      window.removeEventListener("hashchange", onNavigate);
    };
  }, []);
  return refusal ? <ProjectNoAccessScreen creatorName={refusal.creator?.name} /> : <>{children}</>;
}

export function ProjectNoAccessScreen({ creatorName }: { creatorName?: string }) {
  useDocumentTitle("Pas d'accès");
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <Logo />
        <h1 className={styles.title}>Pas d'accès à ce projet</h1>
        <p className={styles.text}>
          {creatorName ? `Ce projet est privé. Demande à ${creatorName}, qui l'a créé, de t'y ajouter.` : "Ce projet est privé. Demande à la personne qui l'a créé de t'y ajouter."}
        </p>
        <Button onClick={() => navigateTo({ name: "home" })}>
          Retour à l'accueil
        </Button>
      </main>
    </div>
  );
}
