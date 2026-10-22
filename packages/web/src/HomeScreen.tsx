import type { ReactNode } from "react";
import type { WorkOverview } from "@redline/shared";
import { relativeTime } from "./relativeTime.js";
import { routeHref } from "./router.js";
import { useHome } from "./useHome.js";

const panel = { background: "#FFFFFF", border: "1px solid #E4E2DC", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" } as const;
const line = { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid #F3F2EE", fontSize: 14, textDecoration: "none", color: "inherit" } as const;

function Panel({ title, link, testId, children }: { title: string; link?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} style={panel}>
      <div style={{ display: "flex", alignItems: "center", padding: "16px 18px", borderBottom: "1px solid #EEEDE8" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
        <span style={{ flexGrow: 1 }} />
        {link}
      </div>
      {children}
    </section>
  );
}

function workLabel(work: WorkOverview): string {
  const threads = work.threadCount === 0 ? "" : ` · ${work.threadCount} ${work.threadCount === 1 ? "fil" : "fils"}`;
  if (work.state === "running") return `En cours${work.agentMachine ? ` sur ${work.agentMachine}` : ""}${threads}`;
  return `${work.reason === "agent-offline" ? "Attend l'agent" : "En file"}${threads}`;
}

export function HomeScreen() {
  const { home } = useHome();
  if (!home) return <main style={{ padding: "36px 44px" }}>Chargement…</main>;

  const running = home.work.filter((w) => w.state === "running").length;
  return (
    <main style={{ padding: "36px 44px", display: "grid", gap: 24 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Accueil</h1>
        <div data-testid="home-summary" style={{ fontSize: 14, color: "#5F5F68", marginTop: 6 }}>
          {home.projectCount} {home.projectCount <= 1 ? "projet" : "projets"} · {running} {running <= 1 ? "session en cours" : "sessions en cours"} ·{" "}
          {home.waitingThreads} {home.waitingThreads <= 1 ? "fil en attente" : "fils en attente"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 20 }}>
          <Panel title="Travail en cours" testId="home-work">
            {home.work.length === 0 && <p style={{ margin: 0, padding: "12px 18px", fontSize: 14, color: "#5F5F68" }}>Rien en cours.</p>}
            {home.work.map((work) => (
              <a key={work.workId} href={routeHref({ name: "page", pageId: work.pageId })} style={line}>
                <span style={{ flex: 1, fontWeight: 500 }}>{work.pageTitle}</span>
                <span style={{ flex: 1, fontSize: 13, color: "#5F5F68" }}>{work.projectTitle}</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{workLabel(work)}</span>
              </a>
            ))}
          </Panel>

          <Panel title="Pages récentes" testId="home-recent" link={<a href={routeHref({ name: "projects" })} style={{ fontSize: 13 }}>Tous les projets</a>}>
            {home.recentPages.length === 0 && <p style={{ margin: 0, padding: "12px 18px", fontSize: 14, color: "#5F5F68" }}>Aucune page pour l'instant.</p>}
            {home.recentPages.map(({ page, projectTitle, updatedAt }) => (
              <a key={page.id} href={routeHref({ name: "page", pageId: page.id })} style={line}>
                <span style={{ flex: 1, fontWeight: 500 }}>{page.title}</span>
                <span style={{ flex: 1, fontSize: 13, color: "#5F5F68" }}>{projectTitle}</span>
                <span style={{ fontSize: 12, color: "#5F5F68" }}>{relativeTime(updatedAt)}</span>
              </a>
            ))}
          </Panel>
        </div>

        <Panel title="Agents" testId="home-agents" link={<a href={routeHref({ name: "agents" })} style={{ fontSize: 13 }}>Voir</a>}>
          {home.agents.length === 0 && <p style={{ margin: 0, padding: "12px 18px", fontSize: 14, color: "#5F5F68" }}>Aucun agent connecté.</p>}
          {home.agents.map((agent) => {
            const label = agent.status === "offline" ? "Hors ligne" : agent.running > 0 ? "Occupé" : "Libre";
            return (
              <div key={agent.id} style={line}>
                <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: agent.status === "online" ? "#16A34A" : "#A1A1AA" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{agent.machine}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#5F5F68" }}>{agent.folder}</span>
                </span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
              </div>
            );
          })}
        </Panel>
      </div>
    </main>
  );
}
