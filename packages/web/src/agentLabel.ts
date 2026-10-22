import type { Project } from "@redline/shared";

export function agentLabel(project: Project): string {
  const { agent } = project;
  return agent
    ? `Served by ${agent.machine} (${agent.folder}), ${agent.status}`
    : "No agent serves this project";
}
