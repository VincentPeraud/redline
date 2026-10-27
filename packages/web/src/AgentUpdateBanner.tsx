import { agentName } from "./agentName.js";
import { routeHref } from "./router.js";
import { useHome } from "./useHome.js";
import styles from "./AgentUpdateBanner.module.css";

/** Names of the agents that are not up to date (connected but outdated, or refused), in the order the Agents screen lists them. */
export function useOutdatedAgentNames(): string[] {
  const { home } = useHome();
  if (!home) return [];
  return [...home.agents.filter((agent) => agent.outdated), ...home.refusedAgents].map(agentName);
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
}

function message(names: string[]): string {
  if (names.length === 1) return `L'agent ${names[0]} n'est pas à jour.`;
  return `${names.length} agents ne sont pas à jour : ${joinNames(names)}.`;
}

/** Banner across the top of every screen when an agent runs another CLI build than the server, or was refused. Not dismissable. */
export function AgentUpdateBanner() {
  const names = useOutdatedAgentNames();
  if (names.length === 0) return null;
  return (
    <div role="status" className={styles.banner}>
      <span aria-hidden="true" className={styles.dot} />
      <span className={styles.message}>{message(names)}</span>
      <span className={styles.spacer} />
      <a href={routeHref({ name: "agents" })} className={styles.link}>
        Voir les agents
      </a>
    </div>
  );
}
