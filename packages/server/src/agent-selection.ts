import type { Project } from "@redline/shared";
import { accountLevelIn } from "./access.js";
import type { Store } from "./store.js";

export interface AgentChoice {
  agentId: string;
  /** The global agent runs the work because no project agent is online: sessions start fresh. */
  takeover: boolean;
}

/**
 * The one routing rule: the online project agent runs a project's new work; otherwise the online global agent, if the
 * project's effective setting allows it; otherwise none (the work waits). Whether the project ever had an agent is irrelevant.
 * A design system has no agent of its own: see `chooseDesignSystemAgent`.
 */
/** Whether the agent's person may work on the project: an agent works only where the person who launched it has Écriture. */
function mayWorkOn(store: Store, agentId: string, projectId: string): boolean {
  const owner = store.agentOwner(agentId);
  return owner === undefined || accountLevelIn(store, owner, projectId) === "write";
}

/** The online global agent that may work on the project, if any. */
export function globalAgentFor(store: Store, projectId: string): string | undefined {
  return store.findOnlineGlobalAgentId((agentId) => mayWorkOn(store, agentId, projectId));
}

export function chooseAgent(store: Store, projectId: string, viaProjectId?: string): AgentChoice | undefined {
  if (store.isDesignSystemProject(projectId)) return chooseDesignSystemAgent(store, projectId, viaProjectId);
  const found = store.findOnlineProjectAgentId(projectId);
  const projectAgentId = found && mayWorkOn(store, found, projectId) ? found : undefined;
  // An updating project agent takes no new work, and the global agent does not step in for a restart of a few minutes.
  if (projectAgentId && store.isAgentUpdating(projectAgentId)) return undefined;
  if (projectAgentId) return { agentId: projectAgentId, takeover: false };
  if (!store.getProject(projectId)?.globalTakeover) return undefined;
  return globalAgent(store, projectId);
}

/**
 * A design system's work runs on the online agent of a project that uses it: the project it was opened from
 * (`viaProjectId`), else the oldest one; the first one found updating makes the work wait for its restart, as for a project.
 * With none running, the default setting decides: the work waits, or the global agent takes it. A design system no project
 * uses yet can only be served by the global agent: it takes it whatever the setting.
 */
function chooseDesignSystemAgent(store: Store, designSystemId: string, viaProjectId?: string): AgentChoice | undefined {
  // An archived follower's agent no longer takes work, but the design system still counts as used (no global fallback for that alone).
  const followers = store.projectsUsingDesignSystem(designSystemId);
  const users = followers.filter((p) => !p.archived).map((p) => p.id);
  const ordered = viaProjectId && users.includes(viaProjectId) ? [viaProjectId, ...users.filter((id) => id !== viaProjectId)] : users;
  for (const id of ordered) {
    const agentId = store.findOnlineProjectAgentId(id);
    if (agentId && mayWorkOn(store, agentId, id)) return store.isAgentUpdating(agentId) ? undefined : { agentId, takeover: false };
  }
  return followers.length === 0 || store.getGlobalTakeover() ? globalAgent(store, designSystemId) : undefined;
}

function globalAgent(store: Store, projectId: string): AgentChoice | undefined {
  const globalId = globalAgentFor(store, projectId);
  return globalId ? { agentId: globalId, takeover: true } : undefined;
}

/** The project with the agent that serves it now, for the API. */
export function withServedBy(store: Store, project: Project): Project {
  const choice = chooseAgent(store, project.id);
  const agent = choice && store.getAgent(choice.agentId);
  return agent ? { ...project, servedBy: { id: agent.id, machine: agent.machine, folder: agent.folder, kind: agent.kind, takeover: choice.takeover } } : project;
}
