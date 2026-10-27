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
 */
export function chooseAgent(store: Store, projectId: string): AgentChoice | undefined {
  const projectAgentId = store.findOnlineProjectAgentId(projectId);
  if (projectAgentId) return { agentId: projectAgentId, takeover: false };
  // A design system has no project record to set a preference on: the global agent serves it.
  const project = store.getProject(projectId);
  if (project && !project.globalTakeover) return undefined;
  const globalId = store.findOnlineGlobalAgentId();
  return globalId ? { agentId: globalId, takeover: true } : undefined;
}

/** The project with the agent that serves it now, for the API. */
export function withServedBy(store: Store, project: Project): Project {
  const choice = chooseAgent(store, project.id);
  const agent = choice && store.getAgent(choice.agentId);
  return agent ? { ...project, servedBy: { id: agent.id, machine: agent.machine, folder: agent.folder, kind: agent.kind, takeover: choice.takeover } } : project;
}
