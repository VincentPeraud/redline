import type { Project } from "@redline/shared";
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
export function chooseAgent(store: Store, projectId: string, viaProjectId?: string): AgentChoice | undefined {
  if (store.isDesignSystemProject(projectId)) return chooseDesignSystemAgent(store, projectId, viaProjectId);
  const projectAgentId = store.findOnlineProjectAgentId(projectId);
  // An updating project agent takes no new work, and the global agent does not step in for a restart of a few minutes.
  if (projectAgentId && store.isAgentUpdating(projectAgentId)) return undefined;
  if (projectAgentId) return { agentId: projectAgentId, takeover: false };
  if (!store.getProject(projectId)?.globalTakeover) return undefined;
  return globalAgent(store);
}

/**
 * A design system's work runs on the online agent of a project that uses it: the project it was opened from
 * (`viaProjectId`), else the oldest one; the first one found updating makes the work wait for its restart, as for a project.
 * With none running, the default setting decides: the work waits, or the global agent takes it. A design system no project
 * uses yet can only be served by the global agent: it takes it whatever the setting.
 */
function chooseDesignSystemAgent(store: Store, designSystemId: string, viaProjectId?: string): AgentChoice | undefined {
  const users = store.projectsUsingDesignSystem(designSystemId).map((p) => p.id);
  const ordered = viaProjectId && users.includes(viaProjectId) ? [viaProjectId, ...users.filter((id) => id !== viaProjectId)] : users;
  for (const id of ordered) {
    const agentId = store.findOnlineProjectAgentId(id);
    if (agentId) return store.isAgentUpdating(agentId) ? undefined : { agentId, takeover: false };
  }
  return users.length === 0 || store.getGlobalTakeover() ? globalAgent(store) : undefined;
}

function globalAgent(store: Store): AgentChoice | undefined {
  const globalId = store.findOnlineGlobalAgentId();
  return globalId ? { agentId: globalId, takeover: true } : undefined;
}

/** The project with the agent that serves it now, for the API. */
export function withServedBy(store: Store, project: Project): Project {
  const choice = chooseAgent(store, project.id);
  const agent = choice && store.getAgent(choice.agentId);
  return agent ? { ...project, servedBy: { id: agent.id, machine: agent.machine, folder: agent.folder, kind: agent.kind, takeover: choice.takeover } } : project;
}
