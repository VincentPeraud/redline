import { useEffect, useState } from "react";
import type { AgentOverview, AgentTokenResponse, UpdateProjectRequest } from "@redline/shared";
import { routeHref } from "./router.js";
import { relativeTime } from "./relativeTime.js";
import { useHome } from "./useHome.js";

function maskToken(token: string): string {
  return token.length <= 8 ? "••••" : `${token.slice(0, 4)}••••••••••${token.slice(-4)}`;
}

const card = { background: "#FFFFFF", border: "1px solid #E4E2DC", borderRadius: 12, padding: 18 } as const;
const mono = { fontFamily: "'JetBrains Mono', monospace", fontSize: 13 } as const;

function statusOf(agent: AgentOverview): { label: string; color: string } {
  if (agent.status === "offline") return { label: "Hors ligne", color: "#A1A1AA" };
  return agent.running > 0 ? { label: "Occupé", color: "#D97706" } : { label: "Libre", color: "#16A34A" };
}

function activity(agent: AgentOverview): string {
  if (agent.status === "offline") {
    return agent.waitingThreads > 0 ? `${agent.waitingThreads} ${agent.waitingThreads === 1 ? "fil attend" : "fils attendent"} son retour` : "";
  }
  const running = agent.running === 0 ? "Aucune session en cours" : `${agent.running} ${agent.running === 1 ? "session en cours" : "sessions en cours"}`;
  return agent.waitingThreads > 0 ? `${running} · ${agent.waitingThreads} en file` : running;
}

const TAKEOVER_OPTIONS = [
  { allow: false, title: "Le fil attend son retour", description: "La session est reprise sur la bonne machine, avec tout son contexte." },
  { allow: true, title: "L'agent global prend le relais", description: "Le fil repart dans une nouvelle session, sans le contexte du projet." },
];

function TakeoverChoice({ projectId, projectTitle, allow, onChange }: { projectId: string; projectTitle: string; allow: boolean; onChange: () => void }) {
  async function choose(next: boolean) {
    const body: UpdateProjectRequest = { allowGlobalTakeover: next };
    await fetch(`/api/projects/${projectId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    onChange();
  }
  return (
    <fieldset style={{ border: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 8 }}>
      <legend style={{ fontSize: 13, fontWeight: 600, padding: 0, marginBottom: 8 }}>Quand l'agent de {projectTitle} est hors ligne</legend>
      {TAKEOVER_OPTIONS.map((option) => (
        <label
          key={option.title}
          style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, borderRadius: 8, border: allow === option.allow ? "2px solid #D92D20" : "1px solid #D4D2CC", cursor: "pointer" }}
        >
          <input type="radio" name={`takeover-${projectId}`} checked={allow === option.allow} onChange={() => void choose(option.allow)} />
          <span>
            <span style={{ display: "block", fontSize: 14, fontWeight: 500 }}>{option.title}</span>
            <span style={{ display: "block", fontSize: 12, color: "#5F5F68" }}>{option.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function AgentCard({ agent, onChange }: { agent: AgentOverview; onChange: () => void }) {
  const status = statusOf(agent);
  const global = agent.kind === "global";
  return (
    <article data-testid="agent-card" style={{ ...card, display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span role="img" aria-label={agent.status === "online" ? "En ligne" : "Hors ligne"} style={{ width: 8, height: 8, borderRadius: "50%", background: status.color }} />
        <strong style={{ fontSize: 15 }}>{agent.machine}</strong>
        <span style={{ fontSize: 12, color: "#5F5F68" }}>{global ? "Agent global" : "Agent de projet"}</span>
        <span style={{ flexGrow: 1 }} />
        <span data-testid="agent-status" style={{ fontSize: 13, fontWeight: 500 }}>{status.label}</span>
      </div>
      <div style={mono}>
        {agent.folder}
        {agent.status === "offline" && <span style={{ color: "#5F5F68" }}> · vu {relativeTime(agent.lastSeenAt)}</span>}
      </div>
      <div data-testid="agent-defaults" style={{ fontSize: 12 }}>
        {agent.model ?? "modèle par défaut"} · {agent.effort ?? "effort par défaut"}
      </div>
      <div style={{ fontSize: 13 }}>
        <span style={{ color: "#5F5F68" }}>{global ? "Projets sans agent : " : "Projet : "}</span>
        {agent.projects.length === 0 ? (
          <span data-testid="agent-projects">{global ? "aucun" : "aucun projet lié"}</span>
        ) : (
          <span data-testid="agent-projects">
            {agent.projects.map((project, index) => (
              <span key={project.id}>
                {index > 0 && ", "}
                <a href={routeHref({ name: "project", projectId: project.id })}>{project.title}</a>
              </span>
            ))}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#5F5F68" }}>{activity(agent)}</div>
      {!global &&
        agent.projects.map((project) => (
          <TakeoverChoice key={project.id} projectId={project.id} projectTitle={project.title} allow={project.allowGlobalTakeover} onChange={onChange} />
        ))}
    </article>
  );
}

function Command({ children }: { children: string }) {
  return <pre style={{ ...mono, margin: 0, background: "#F3F2EE", borderRadius: 8, padding: "8px 10px", overflowX: "auto" }}>{children}</pre>;
}

function LaunchCommands() {
  const login = `npm i -g redline-cli\nredline login ${window.location.origin}`;
  return (
    <section aria-label="Lancer un agent" style={{ ...card, display: "grid", gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Lancer un agent</h2>
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 14 }}>Une fois par machine</strong>
        <span style={{ fontSize: 13, color: "#5F5F68" }}>
          Installe la commande (Claude Code doit être installé et connecté), puis indique l'adresse du serveur et colle le jeton : ils sont enregistrés pour tous les agents de la machine.
        </span>
        <Command>{login}</Command>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 14 }}>Agent de projet</strong>
        <span style={{ fontSize: 13, color: "#5F5F68" }}>
          Dans le dossier du projet. --model et --effort donnent les valeurs par défaut de ses fils (sinon, ta configuration Claude Code). S'il n'est lié à aucun projet, la commande te propose d'en choisir un ou d'en créer un. Les sessions auront son CLAUDE.md, son code et ses MCP.
        </span>
        <Command>{"cd ~/projets/mon-projet\nredline agent"}</Command>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 14 }}>Agent global</strong>
        <span style={{ fontSize: 13, color: "#5F5F68" }}>N'importe où. Il prend les projets qui n'ont pas d'agent.</span>
        <Command>redline agent --global</Command>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 14 }}>Depuis ta session Claude Code</strong>
        <span style={{ fontSize: 13, color: "#5F5F68" }}>Une fois : Claude pilote alors Redline depuis n'importe quel dossier.</span>
        <Command>claude mcp add redline -- redline mcp</Command>
      </div>
    </section>
  );
}

function TokenSection() {
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/agent-token")
      .then((res) => res.json() as Promise<AgentTokenResponse>)
      .then((body) => setToken(body.token));
  }, []);

  async function copy() {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function regenerate() {
    if (!window.confirm("Régénérer le jeton déconnecte tous les agents. Continuer ?")) return;
    const res = await fetch("/api/agent-token/regenerate", { method: "POST" });
    setToken(((await res.json()) as AgentTokenResponse).token);
  }

  return (
    <section aria-label="Jeton des agents" style={{ ...card, display: "grid", gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Jeton des agents</h2>
      <span style={{ fontSize: 13, color: "#5F5F68" }}>Demandé par redline login. Le régénérer déconnecte tous les agents.</span>
      <div>
        <code data-testid="token">{token ? maskToken(token) : ""}</code>{" "}
        <button type="button" onClick={copy} disabled={!token}>
          {copied ? "Copié" : "Copier"}
        </button>{" "}
        <button type="button" onClick={regenerate}>
          Régénérer
        </button>
      </div>
    </section>
  );
}

export function AgentsScreen() {
  const { home, refresh } = useHome();
  const agents = home?.agents ?? [];

  return (
    <main style={{ padding: "36px 44px", display: "grid", gap: 20, maxWidth: 900 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28 }}>Agents</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14, color: "#5F5F68" }}>
          Un agent tourne sur ta machine, dans un dossier, avec le compte Claude connecté dans le terminal. C'est lui qui lance les sessions.
        </p>
      </div>
      <section aria-label="Agents" style={{ display: "grid", gap: 14 }}>
        {home && agents.length === 0 && <p>Aucun agent ne s'est encore connecté.</p>}
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onChange={refresh} />
        ))}
      </section>
      <LaunchCommands />
      <TokenSection />
    </main>
  );
}
