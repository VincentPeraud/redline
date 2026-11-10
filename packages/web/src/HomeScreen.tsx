import { useEffect, useState, type ReactNode } from "react";
import { SESSIONS_PATH, type DesignSystemSummary, type HomeProject, type SessionRow } from "@redline/shared";
import { PendingPill, RequestsPill } from "./DesignSystemAlerts.js";
import { DesignSystemThumbnail } from "./HomeThumbnails.js";
import { ProjectPreview } from "./ProjectPreview.js";
import { relativeTime } from "./relativeTime.js";
import { routeHref } from "./router.js";
import { Card, CardHeader, PageContent, PageHeader, SessionStatusBadge, StatusBadge, cx } from "./ui/index.js";
import { useHome } from "./useHome.js";
import styles from "./HomeScreen.module.css";

const RECENT_SESSIONS = 4;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count <= 1 ? one : many}`;
}

function projectMeta(project: HomeProject): string {
  const pages = plural(project.pageCount, "page", "pages");
  if (project.waitingThreads > 0 && project.waitingThreads >= project.openThreads) return `${pages} · ${plural(project.waitingThreads, "fil en attente", "fils en attente")}`;
  if (project.openThreads > 0) return `${pages} · ${plural(project.openThreads, "fil ouvert", "fils ouverts")}`;
  return project.updatedAt ? `${pages} · modifié ${relativeTime(project.updatedAt)}` : pages;
}

function Section({ title, link, testId, children }: { title: string; link: ReactNode; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {link}
      </div>
      {children}
    </section>
  );
}

export function HomeScreen() {
  const { home } = useHome();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);

  useEffect(() => {
    fetch("/api/design-systems")
      .then((res) => res.json() as Promise<DesignSystemSummary[]>)
      .then(setDesignSystems);
  }, []);

  // `home` is replaced on every server event: reload the sessions with it so statuses stay live.
  useEffect(() => {
    let cancelled = false;
    fetch(SESSIONS_PATH)
      .then((res) => res.json() as Promise<SessionRow[]>)
      .then((rows) => {
        if (!cancelled) setSessions(rows.slice(0, RECENT_SESSIONS));
      });
    return () => {
      cancelled = true;
    };
  }, [home]);

  if (!home) return <PageContent>Chargement…</PageContent>;

  const running = home.work.filter((w) => w.state === "running").length;
  return (
    <PageContent className={styles.page}>
      <PageHeader
        title="Accueil"
        subtitle={
          <span data-testid="home-summary">
            {plural(home.projectCount, "projet", "projets")} · {plural(running, "session en cours", "sessions en cours")} ·{" "}
            {plural(home.waitingThreads, "fil en attente", "fils en attente")}
            {home.designSystemsToDiffuse > 0 && (
              <>
                {" · "}
                <a data-testid="home-to-diffuse" href={routeHref({ name: "designSystems" })}>
                  {plural(home.designSystemsToDiffuse, "design system", "design systems")} à diffuser
                </a>
              </>
            )}
          </span>
        }
      />

      <div className={styles.topRow}>
        <Card as="section" data-testid="home-sessions">
          <CardHeader title="Sessions récentes" action={<a href={routeHref({ name: "sessions" })} className={styles.link}>Toutes les sessions</a>} />
          {sessions.length === 0 && <p className={styles.empty}>Aucune session pour l'instant.</p>}
          {sessions.map((session) => (
            <a key={session.id} href={routeHref({ name: "sessions" })} className={styles.sessionRow}>
              <span className={styles.sessionName}>{session.name}</span>
              <span className={styles.sessionPlace}>
                {session.projectTitle} › {session.pageTitle}
              </span>
              <SessionStatusBadge status={session.status} size="sm" />
              <span className={styles.sessionTime}>{relativeTime(session.activityAt)}</span>
            </a>
          ))}
        </Card>

        <Card as="section" data-testid="home-agents">
          <CardHeader title="Agents" action={<a href={routeHref({ name: "agents" })} className={styles.link}>Voir</a>} />
          {home.agents.length === 0 && <p className={styles.empty}>Aucun agent connecté.</p>}
          {home.agents.map((agent) => (
            <div key={agent.id} className={styles.agentRow}>
              <span aria-hidden="true" className={cx(styles.dot, agent.status === "offline" && styles.dotOffline)} />
              <span className={styles.agentText}>
                <span className={styles.agentName}>{agent.machine}</span>
                <span className={styles.agentFolder}>{agent.folder}</span>
              </span>
              {agent.status === "offline" ? (
                <StatusBadge tone="neutral" size="sm">Hors ligne</StatusBadge>
              ) : agent.running > 0 ? (
                <StatusBadge tone="running" size="sm">Occupé</StatusBadge>
              ) : (
                <StatusBadge tone="success" size="sm">Libre</StatusBadge>
              )}
            </div>
          ))}
        </Card>
      </div>

      <div className={styles.bottomRow}>
        <Section title="Projets" testId="home-projects" link={<a href={routeHref({ name: "projects" })} className={styles.link}>Tous les projets</a>}>
          {home.projects.length === 0 && <p className={styles.empty}>Aucun projet pour l'instant.</p>}
          <div className={styles.projectGrid}>
            {home.projects.map((project) => (
              <a key={project.id} href={routeHref({ name: "project", projectId: project.id })} className={styles.projectCard}>
                <ProjectPreview pageId={project.lastPageId} height={120} />
                <span className={styles.cardText}>
                  <span className={styles.cardTitle}>{project.title}</span>
                  <span className={styles.cardMeta}>{projectMeta(project)}</span>
                </span>
              </a>
            ))}
          </div>
        </Section>

        <Section title="Design systems" testId="home-design-systems" link={<a href={routeHref({ name: "designSystems" })} className={styles.link}>Voir</a>}>
          {designSystems.map((ds, index) => (
            <a key={ds.id} href={routeHref({ name: "designSystems" })} className={styles.dsCard}>
              <DesignSystemThumbnail variant={index} />
              <span className={styles.dsText}>
                <span className={styles.cardTitle}>{ds.title}</span>
                <span className={styles.cardMeta}>
                  {ds.usedBy.length === 0 ? "Utilisé par aucun projet" : `Utilisé par ${plural(ds.usedBy.length, "projet", "projets")}`}
                </span>
                {ds.pendingChanges > 0 && (
                  <span className={styles.dsPills}>
                    <PendingPill changes={ds.pendingChanges} />
                    {ds.requests > 0 && <RequestsPill count={ds.requests} />}
                  </span>
                )}
              </span>
            </a>
          ))}
        </Section>
      </div>
    </PageContent>
  );
}
