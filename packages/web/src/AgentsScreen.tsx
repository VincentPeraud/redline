import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CLI_TARBALL_PATH, cliSetupCommand, instanceFallbackName, instanceHandle, modelLabel, refusedAgentCommand, type AgentOverview, type AgentTokenResponse, type RefusedAgent, type ServerConfig, type Settings } from "@redline/shared";
import { Avatar } from "./Avatar.js";
import { agentName } from "./agentName.js";
import { routeHref } from "./router.js";
import { relativeTime } from "./relativeTime.js";
import { Button, Card, PageContent, PageHeader, StatusBadge, cx } from "./ui/index.js";
import { useHome } from "./useHome.js";
import styles from "./AgentsScreen.module.css";

function useConfig(): ServerConfig | null {
  const [config, setConfig] = useState<ServerConfig | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json() as Promise<ServerConfig>)
      .then(setConfig);
  }, []);

  return config;
}

function InstanceBadge({ config }: { config: ServerConfig | null }) {
  if (!config) return null;
  const text = config.instanceName ? `${config.instanceName} · v${config.version}` : `v${config.version}`;
  return (
    <StatusBadge tone="neutral" className={styles.instanceBadge} data-testid="instance-badge">
      {text}
    </StatusBadge>
  );
}

function maskToken(token: string, dots: number): string {
  return token.length <= 8 ? "••••" : `${token.slice(0, 4)}${"•".repeat(dots)}${token.slice(-4)}`;
}

function activity(agent: AgentOverview): { text: string; warn: boolean } {
  if (agent.status === "offline") {
    const text = agent.waitingThreads > 0 ? `${agent.waitingThreads} ${agent.waitingThreads === 1 ? "fil attend" : "fils attendent"} un agent` : "";
    return { text, warn: true };
  }
  const running = agent.running === 0 ? "Aucune session en cours" : `${agent.running} ${agent.running === 1 ? "session en cours" : "sessions en cours"}`;
  return { text: agent.waitingThreads > 0 ? `${running} · ${agent.waitingThreads} en file` : running, warn: false };
}

const TAKEOVER_OPTIONS = [
  { allow: false, title: "Le fil attend", description: "Il part dès qu'un agent est lancé dans le dossier du projet, avec tout son contexte." },
  { allow: true, title: "L'agent global le prend", description: "Le fil part tout de suite dans une session de l'agent global, sans le contexte du projet." },
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
    <Card as="section" padding="md" aria-labelledby="no-agent-setting">
      <h2 id="no-agent-setting" className={styles.fallbackTitle}>Quand aucun agent ne tourne pour le projet</h2>
      <p className={styles.settingHint}>Réglage par défaut. Chaque projet peut le changer depuis la pastille d'agent de son canvas.</p>
      <div role="radiogroup" aria-labelledby="no-agent-setting" className={styles.options}>
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

/** Projects shown before "+ N autres". */
const SHOWN_PROJECTS = 3;

function ProjectList({ agent }: { agent: AgentOverview }) {
  const [all, setAll] = useState(false);
  const global = agent.kind === "global";
  if (agent.projects.length === 0) return <span className={styles.secondary}>{global ? "Aucun projet ne lui laisse la main" : "Aucun projet lié"}</span>;
  // A single hidden project is shown rather than replaced by a button of the same height.
  const hidden = agent.projects.length > SHOWN_PROJECTS + 1 ? agent.projects.length - SHOWN_PROJECTS : 0;
  const shown = all || hidden === 0 ? agent.projects : agent.projects.slice(0, SHOWN_PROJECTS);
  return (
    <ul className={styles.projectList} aria-label={global ? "Projets couverts" : "Projets"} data-testid="agent-projects">
      {shown.map((project, index) => (
        <li key={project.private ? `private-${index}` : project.id} className={styles.projectItem}>
          {project.private ? (
            <span className={styles.projectName}>{project.title}</span>
          ) : (
            <a className={styles.projectLink} href={routeHref({ name: "project", projectId: project.id })}>
              {project.title}
            </a>
          )}
          {global && project.servedNow && <span className={styles.servedNow}>sert maintenant</span>}
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button type="button" className={styles.more} aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Réduire" : `+ ${hidden} ${hidden === 1 ? "autre" : "autres"}`}
          </button>
        </li>
      )}
    </ul>
  );
}

/** A folder on one line, cut at its start so the last segments, the ones that tell agents apart, stay visible. */
function Folder({ path }: { path: string }) {
  return (
    <span className={styles.folder} dir="rtl" title={path}>
      <bdi>{path}</bdi>
    </span>
  );
}

function LaunchedBy({ agent }: { agent: AgentOverview }) {
  if (!agent.launchedBy) return <span className={styles.secondary}>-</span>;
  return (
    <div className={styles.by}>
      <Avatar initials={agent.launchedBy.initials} muted />
      <span>{agent.launchedBy.name}</span>
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentOverview }) {
  const global = agent.kind === "global";
  const offline = agent.status === "offline";
  const busy = agent.running > 0;
  const { text: activityText, warn } = activity(agent);
  const updatable = agent.outdated && !offline;
  return (
    <div role="row" className={styles.row} data-testid="agent-card">
      <div role="cell" className={styles.cell}>
        <div className={styles.nameLine}>
          <span role="img" aria-label={offline ? "Hors ligne" : "En ligne"} className={cx(styles.dot, !offline && styles.dotOnline)} />
          <span className={styles.name}>{agentName(agent)}</span>
        </div>
        <span className={styles.secondary}>{global ? "Agent global" : "Agent de projet"}</span>
      </div>
      <div role="cell" className={styles.cell}>
        <LaunchedBy agent={agent} />
      </div>
      <div role="cell" className={styles.cell}>
        <Folder path={agent.folder} />
        <span className={styles.secondary}>
          {agent.machine}
          {offline && ` · vu ${relativeTime(agent.lastSeenAt)}`}
        </span>
        <span className={styles.secondary} data-testid="agent-defaults">
          {agent.model ? modelLabel(agent.model) : "modèle par défaut"} · {agent.effort ?? "effort par défaut"}
        </span>
      </div>
      <div role="cell" className={styles.cell}>
        <ProjectList agent={agent} />
        {activityText && <span className={cx(styles.secondary, warn && styles.warn)}>{activityText}</span>}
        {agent.updateError && (
          <span className={cx(styles.secondary, styles.warn)} data-testid="agent-update-error">
            La mise à jour a échoué : {agent.updateError}
          </span>
        )}
      </div>
      <div role="cell" className={styles.state}>
        <div className={styles.badges}>
          <StatusBadge tone={offline ? "neutral" : busy ? "running" : "success"} data-testid="agent-status">
            {offline ? "Hors ligne" : busy ? "Occupé" : "Libre"}
          </StatusBadge>
          {agent.outdated && <StatusBadge tone="warning" data-testid="agent-outdated">Pas à jour</StatusBadge>}
        </div>
        {updatable && (
          <Button variant="primary" className={styles.rowAction} disabled={agent.updating} onClick={() => void fetch(`/api/agents/${agent.id}/update`, { method: "POST" })}>
            {agent.updating ? "Mise à jour…" : "Mettre à jour"}
          </Button>
        )}
      </div>
    </div>
  );
}

function RefusedAgentRow({ agent }: { agent: RefusedAgent }) {
  const [copied, copy] = useCopy();
  const command = refusedAgentCommand(window.location.origin, agent.beforeInstances === true);

  return (
    <div role="row" className={cx(styles.row, styles.refused)} data-testid="refused-agent-card">
      <div role="cell" className={styles.cell}>
        <div className={styles.nameLine}>
          <span aria-hidden="true" className={styles.dot} />
          <span className={styles.name}>{agentName(agent)}</span>
        </div>
        <span className={styles.secondary}>{agent.kind === "global" ? "Agent global" : "Agent de projet"}</span>
      </div>
      <div role="cell" className={styles.cell} />
      <div role="cell" className={styles.cell}>
        <Folder path={agent.folder} />
        <span className={styles.secondary}>
          {agent.machine} · refusé {relativeTime(agent.refusedAt)}
        </span>
      </div>
      <div role="cell" className={styles.cell}>
        {agent.project && <span className={styles.projectName}>{agent.project}</span>}
        <span className={styles.secondary}>Ne peut plus se connecter</span>
      </div>
      <div role="cell" className={styles.state}>
        <div className={styles.badges}>
          <StatusBadge tone="danger">Pas à jour · refusé</StatusBadge>
        </div>
        {agent.beforeInstances && <span className={styles.secondary}>Installé avant les instances : la commande met Redline à jour puis déplace son installation.</span>}
        <code className={styles.refusedCommand}>
          {command.split(/(?<=\/)/).map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <wbr />}
              {part}
            </Fragment>
          ))}
        </code>
        <Button className={styles.rowAction} onClick={() => void copy(command)}>
          {copied ? "Copié" : "Copier la commande"}
        </Button>
      </div>
    </div>
  );
}

function Step({ title, text, command, children }: { title: string; text: ReactNode; command: string; children?: ReactNode }) {
  return (
    <div className={styles.step}>
      <div className={styles.stepTitle}>{title}</div>
      <div className={styles.stepText}>{text}</div>
      <pre className={styles.code}>{command}</pre>
      {children}
    </div>
  );
}

function useCopy(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return [copied, copy];
}

function TokenSection({ token, onToken }: { token: string; onToken: (token: string) => void }) {
  const [copied, copy] = useCopy();

  async function regenerate() {
    if (!window.confirm("Régénérer ton jeton déconnecte tes agents. Continuer ?")) return;
    const res = await fetch("/api/agent-token/regenerate", { method: "POST" });
    onToken(((await res.json()) as AgentTokenResponse).token);
  }

  return (
    <section aria-label="Ton jeton d'agent" className={styles.token}>
      <div className={styles.stepTitle}>Ton jeton d'agent</div>
      <div className={styles.tokenHint}>Personnel : ne le donne à personne. Le régénérer ne déconnecte que tes agents.</div>
      <div className={styles.tokenValue}>
        <code data-testid="token">{token ? maskToken(token, 11) : ""}</code>
      </div>
      <div className={styles.tokenActions}>
        <Button onClick={() => void copy(token)} disabled={!token}>
          {copied ? "Copié" : "Copier"}
        </Button>
        <Button variant="danger" onClick={regenerate}>
          Régénérer
        </Button>
      </div>
    </section>
  );
}

function LaunchPanel({ closing, config, onClose, onClosed, trigger }: { closing: boolean; config: ServerConfig | null; onClose: () => void; onClosed: () => void; trigger: RefObject<HTMLButtonElement | null> }) {
  const [token, setToken] = useState("");
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copied, copy] = useCopy();
  const origin = window.location.origin;

  useEffect(() => {
    fetch("/api/agent-token")
      .then((res) => res.json() as Promise<AgentTokenResponse>)
      .then((body) => setToken(body.token));
  }, []);

  // Focus goes into the panel and back to "Lancer un agent" when it closes; Escape or a click on the page closes it.
  useEffect(() => {
    closeButton.current?.focus();
    const button = trigger.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button?.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      button?.focus();
    };
  }, [onClose, trigger]);

  const setupCommand = cliSetupCommand(origin, token);
  const shownCommand = `npx -y ${origin}${CLI_TARBALL_PATH} \\\n  setup ${origin} --token ${token ? maskToken(token, 7) : ""}`;
  const instanceName = config?.instanceName ?? instanceFallbackName(origin);
  const handle = instanceHandle(instanceName);

  return (
    <aside
      ref={panel}
      aria-label="Lancer un agent"
      className={cx(styles.launchPanel, closing && styles.launchPanelClosing)}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) onClosed();
      }}
    >
      <div className={styles.setup}>
        <div className={styles.setupHead}>
          <div className={styles.setupTitles}>
            <h2 className={styles.setupTitle}>Lancer un agent</h2>
            <InstanceBadge config={config} />
          </div>
          <button ref={closeButton} type="button" aria-label="Fermer" className={styles.close} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        </div>
        <p className={styles.intro}>L'agent tourne sur ta machine avec <strong className={styles.strong}>tes droits</strong> : il ne voit que les projets que tu vois et n'écrit que là où tu écris.</p>
        <Step
          title="Une fois par machine"
          text={
            <>
              Claude Code doit être installé et connecté. La commande :
              <ol className={styles.setupSteps}>
                <li>
                  installe la commande <code className={styles.inlineCode}>redline</code> de ce serveur si elle manque ou si celle de ta machine est plus ancienne ;
                </li>
                <li>
                  crée l'installation de <strong className={styles.strong}>{instanceName}</strong> sur ta machine, à la version de ce serveur, avec ton jeton ;
                </li>
                <li>
                  <strong className={styles.strong}>connecte le MCP Redline à Claude Code</strong> : dans un dossier lié à {instanceName}, Claude crée des pages et publie ici.
                </li>
              </ol>
            </>
          }
          command={shownCommand}
        >
          <Button variant="primary" className={styles.copyCommand} onClick={() => void copy(setupCommand)} disabled={!token}>
            {copied ? "Copié" : "Copier la commande"}
          </Button>
          <div className={styles.verify}>
            Déjà d'autres instances sur ta machine ? Chacune garde sa version : celle-ci s'ajoute à côté. Pour vérifier, lance <code className={styles.inlineCode}>redline doctor</code>.
          </div>
        </Step>
        <Step
          title="Lier un dossier"
          text={`Dans le dossier du projet, sans agent : ses sessions Claude Code publient sur ${instanceName}.`}
          command={`cd ~/projets/mon-projet\nredline link ${handle}`}
        />
        <Step
          title="Agent de projet"
          text="Dans le dossier du projet. La première fois, la commande te propose de le lier à un projet existant ou d'en créer un. Ses sessions ont le CLAUDE.md, le code et les MCP du dossier."
          command="redline agent"
        />
        <Step
          title="Agent global"
          text="N'importe où. Il prend les projets qui l'autorisent quand aucun agent ne tourne pour eux."
          command={`redline agent --global --instance ${handle}`}
        />
        <div className={styles.spacer} />
        <TokenSection token={token} onToken={setToken} />
      </div>
    </aside>
  );
}

export function AgentsScreen() {
  const { home, refresh } = useHome();
  const config = useConfig();
  /** The launch panel slides in when opened and out before it unmounts. */
  const [launch, setLaunch] = useState<"closed" | "open" | "closing">("closed");
  const launchButton = useRef<HTMLButtonElement>(null);
  const closeLaunch = useCallback(() => setLaunch((current) => (current === "open" ? "closing" : current)), []);
  const agents = home?.agents ?? [];
  const refused = home?.refusedAgents ?? [];

  return (
    <>
      <PageContent>
        <PageHeader
          title="Agents"
          badge={<InstanceBadge config={config} />}
          subtitle="Chaque agent tourne avec le jeton de la personne qui l'a lancé, et n'a que ses droits."
          actions={
            <Button ref={launchButton} variant="accent" aria-expanded={launch === "open"} onClick={() => (launch === "open" ? closeLaunch() : setLaunch("open"))}>
              Lancer un agent
            </Button>
          }
        />
        {!home ? null : agents.length === 0 && refused.length === 0 ? (
          <p className={styles.empty}>Aucun agent ne s'est encore connecté.</p>
        ) : (
          <div role="table" aria-label="Agents" className={styles.table}>
            <div role="row" className={cx(styles.row, styles.headRow)}>
              <span role="columnheader">Agent</span>
              <span role="columnheader">Lancé par</span>
              <span role="columnheader">Dossier</span>
              <span role="columnheader">Projets</span>
              <span role="columnheader">État</span>
            </div>
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
            {refused.map((agent) => (
              <RefusedAgentRow key={`${agent.machine}:${agent.folder}`} agent={agent} />
            ))}
          </div>
        )}
        <GlobalTakeoverSetting onChange={refresh} />
      </PageContent>
      {launch !== "closed" && <LaunchPanel closing={launch === "closing"} config={config} onClose={closeLaunch} onClosed={() => setLaunch("closed")} trigger={launchButton} />}
    </>
  );
}
