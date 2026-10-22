import type { Project } from "@redline/shared";

export function agentLabel(project: Project): string {
  const { agent, servedBy } = project;
  if (servedBy?.kind === "global") {
    const where = `${servedBy.machine} (${servedBy.folder})`;
    return servedBy.takeover
      ? `Served by the global agent ${where}, taking over while the project agent is offline`
      : `Served by the global agent ${where}`;
  }
  if (servedBy) return `Served by ${servedBy.machine} (${servedBy.folder}), online`;
  if (agent) return `Project agent ${agent.machine} (${agent.folder}) is offline, threads wait`;
  return "No agent serves this project";
}
