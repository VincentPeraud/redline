import type { AgentKind } from "@redline/shared";

/** "global" for the global agent, else the folder's name. */
export function agentName(agent: { kind: AgentKind; folder: string }): string {
  if (agent.kind === "global") return "global";
  return agent.folder.split("/").filter(Boolean).pop() ?? agent.folder;
}
