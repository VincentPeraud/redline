import type { Project } from "@redline/shared";
import type { Store } from "./store.js";

export interface AgentChoice {
  agentId: string;
  /** The global agent runs the work in place of a project agent that is offline: sessions start fresh. */
  takeover: boolean;
}

/**
 * Which online agent runs a project's new work: its project agent; the global agent when the project has none;
 * the global agent when the project agent is offline and the project allows the takeover. Otherwise none (the work waits).
 */
export function chooseAgent(store: Store, projectId: string): AgentChoice | undefined {
  const projectAgentId = store.findOnlineProjectAgentId(projectId);
  if (projectAgentId) return { agentId: projectAgentId, takeover: false };
  const hasProjectAgent = store.hasProjectAgent(projectId);
  if (hasProjectAgent && !store.getProject(projectId)?.globalTakeover) return undefined;
  const globalId = store.findOnlineGlobalAgentId();
  return globalId ? { agentId: globalId, takeover: hasProjectAgent } : undefined;
}

/** The project with the agent that serves it now, for the API. */
export function withServedBy(store: Store, project: Project): Project {
  const choice = chooseAgent(store, project.id);
  const agent = choice && store.getAgent(choice.agentId);
  return agent ? { ...project, servedBy: { id: agent.id, machine: agent.machine, folder: agent.folder, kind: agent.kind, takeover: choice.takeover } } : project;
}
