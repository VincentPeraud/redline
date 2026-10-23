import { useEffect, useState } from "react";
import { modelLabel, type AgentOverview, type AgentTokenResponse, type Settings } from "@redline/shared";
import { routeHref } from "./router.js";
import { relativeTime } from "./relativeTime.js";
import { Button, Card, PageContent, PageHeader, SidePanel, StatusBadge, cx } from "./ui/index.js";
import { useHome } from "./useHome.js";
import styles from "./AgentsScreen.module.css";

function maskToken(token: string): string {
  return token.length <= 8 ? "••••" : `${token.slice(0, 4)}••••••••••${token.slice(-4)}`;
}

function agentName(agent: AgentOverview): string {
  if (agent.kind === "global") return "global";
  return agent.folder.split("/").filter(Boolean).pop() ?? agent.folder;
}

function activity(agent: AgentOverview): { text: string; warn: boolean } {
  if (agent.status === "offline") {
    const text = agent.waitingThreads > 0 ? `${agent.waitingThreads} ${agent.waitingThreads === 1 ? "fil attend" : "fils attendent"} son retour` : "";
    return { text, warn: true };
  }
  const running = agent.running === 0 ? "Aucune session en cours" : `${agent.running} ${agent.running === 1 ? "session en cours" : "sessions en cours"}`;
  return { text: agent.waitingThreads > 0 ? `${running} · ${agent.waitingThreads} en file` : running, warn: false };
}

const TAKEOVER_OPTIONS = [
  { allow: false, title: "Le fil attend son retour", description: "La session est reprise sur la bonne machine, avec tout son contexte." },
  { allow: true, title: "L'agent global prend le relais", description: "Le fil repart dans une nouvelle session, sans le contexte du projet." },
];

function GlobalTakeoverSetting({ onChange }: { onChange: () => void }) {
  const [takeover, setTakeover] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json() as Promise<Settings>)
      .then((settings) => setTakeover(settings.globalTakeover));
  }, []);

  async function choose(next: boolean) {
    setTakeover(next);
    const body: Partial<Settings> = { globalTakeover: next };
    await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    onChange();
  }

  return (
    <Card as="section" padding="md" aria-label="Relais hors ligne">
      <h2 className={styles.fallbackTitle}>Quand l'agent d'un projet est hors ligne</h2>
      <div role="radiogroup" aria-label="Quand l'agent d'un projet est hors ligne" className={styles.options}>
        {TAKEOVER_OPTIONS.map((option) => {
          const on = takeover === option.allow;
          return (
            <label key={option.title} className={cx(styles.option, on && styles.optionOn)}>
              <input type="radio" className={styles.radio} name="global-takeover" checked={on} onChange={() => void choose(option.allow)} />
              <span className={styles.optionText}>
                <span className={styles.optionTitle}>{option.title}</span>
                <span className={styles.optionDesc}>{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

function AgentCard({ agent }: { agent: AgentOverview }) {
  const [open, setOpen] = useState(false);
  const global = agent.kind === "global";
  const offline = agent.status === "offline";
  const busy = agent.running > 0;
  const { text: activityText, warn } = activity(agent);
  return (
    <Card as="article" padding="lg" data-testid="agent-card">
      <div className={styles.row}>
        <div className={styles.cell}>
          <div className={styles.nameLine}>
            <span role="img" aria-label={offline ? "Hors ligne" : "En ligne"} className={cx(styles.dot, !offline && styles.dotOnline)} />
            <span className={styles.name}>{agentName(agent)}</span>
          </div>
          <span className={styles.secondary}>{global ? "Agent global" : "Agent de projet"}</span>
        </div>
        <div className={styles.cell}>
          <span className={styles.folder}>{agent.folder}</span>
          <span className={styles.secondary}>
            {agent.machine}
            {offline && ` · vu ${relativeTime(agent.lastSeenAt)}`}
          </span>
          <span className={styles.secondary} data-testid="agent-defaults">
            {agent.model ? modelLabel(agent.model) : "modèle par défaut"} · {agent.effort ?? "effort par défaut"}
          </span>
        </div>
        <div className={styles.cell}>
          <span className={styles.projects}>
            <span data-testid="agent-projects">
              {agent.projects.length === 0
                ? global
                  ? "aucun"
                  : "aucun projet lié"
                : agent.projects.map((project, index) => (
                    <span key={project.id}>
                      {index > 0 && ", "}
                      <a className={styles.projectLink} href={routeHref({ name: "project", projectId: project.id })}>{project.title}</a>
                    </span>
                  ))}
            </span>
            {global && ", projets sans agent"}
          </span>
          {activityText && <span className={cx(styles.secondary, warn && styles.warn)}>{activityText}</span>}
        </div>
        <div>
          <StatusBadge tone={offline ? "neutral" : busy ? "running" : "success"} data-testid="agent-status">
            {offline ? "Hors ligne" : busy ? "Occupé" : "Libre"}
          </StatusBadge>
        </div>
        <Button aria-expanded={open} onClick={() => setOpen(!open)}>
          Projets couverts
        </Button>
      </div>
      {open && (
        <ul className={styles.covered} aria-label="Projets couverts">
          {agent.projects.length === 0 && <li>{global ? "Aucun projet sans agent" : "Aucun projet lié"}</li>}
          {agent.projects.map((project) => (
            <li key={project.id} className={styles.coveredItem}>
              <a href={routeHref({ name: "project", projectId: project.id })}>{project.title}</a>
              {!global && <span className={styles.secondary}>{project.globalTakeover ? "L'agent global prend le relais" : "Le fil attend son retour"}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Step({ title, text, command }: { title: string; text: string; command: string }) {
  return (
    <div className={styles.step}>
      <div className={styles.stepTitle}>{title}</div>
      <div className={styles.stepText}>{text}</div>
      <pre className={styles.code}>{command}</pre>
    </div>
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
    <section aria-label="Jeton des agents" className={styles.token}>
      <div className={styles.stepTitle}>Jeton des agents</div>
      <div className={styles.tokenHint}>Demandé par redline login. Le régénérer déconnecte tous les agents.</div>
      <div className={styles.tokenValue}>
        <code data-testid="token">{token ? maskToken(token) : ""}</code>
      </div>
      <div className={styles.tokenActions}>
        <Button onClick={copy} disabled={!token}>
          {copied ? "Copié" : "Copier"}
        </Button>
        <Button variant="danger" onClick={regenerate}>
          Régénérer
        </Button>
      </div>
    </section>
  );
}

function LaunchPanel() {
  return (
    <SidePanel label="Lancer un agent" width={360}>
      <div className={styles.panelWrap}>
        <div className={styles.setup}>
          <h2 className={styles.setupTitle}>Lancer un agent</h2>
          <Step
            title="Une fois par machine"
            text="Installe la commande (Claude Code doit être installé et connecté), puis indique l'adresse du serveur et colle le jeton : ils sont enregistrés pour tous les agents de la machine."
            command={`npm i -g redline-cli\nredline login ${window.location.origin}`}
          />
          <Step
            title="Agent de projet"
            text="Dans le dossier du projet. --model et --effort donnent les valeurs par défaut de ses fils (sinon, ta configuration Claude Code). S'il n'est lié à aucun projet, la commande te propose d'en choisir un ou d'en créer un. Les sessions auront son CLAUDE.md, son code et ses MCP."
            command={"cd ~/projets/mon-projet\nredline agent"}
          />
          <Step title="Agent global" text="N'importe où. Il prend les projets qui n'ont pas d'agent." command="redline agent --global" />
          <Step title="Depuis ta session Claude Code" text="Une fois : Claude pilote alors Redline depuis n'importe quel dossier." command="claude mcp add redline -- redline mcp" />
          <div className={styles.spacer} />
          <TokenSection />
        </div>
      </div>
    </SidePanel>
  );
}

export function AgentsScreen() {
  const { home, refresh } = useHome();
  const agents = home?.agents ?? [];

  return (
    <>
      <PageContent>
        <PageHeader
          title="Agents"
          subtitle="Un agent tourne sur ta machine, dans un dossier, avec le compte Claude connecté dans le terminal. C'est lui qui lance les sessions."
        />
        <section aria-label="Agents" className={styles.list}>
          {home && agents.length === 0 && <p className={styles.empty}>Aucun agent ne s'est encore connecté.</p>}
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </section>
        <GlobalTakeoverSetting onChange={refresh} />
      </PageContent>
      <LaunchPanel />
    </>
  );
}
