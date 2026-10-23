import type { Project } from "@redline/shared";

export function agentLabel(project: Project): string {
  const { agent, servedBy } = project;
  if (servedBy?.kind === "global") {
    const where = `${servedBy.machine} (${servedBy.folder})`;
    return servedBy.takeover
      ? `Servi par l'agent global ${where}, en remplacement de l'agent du projet hors ligne`
      : `Servi par l'agent global ${where}`;
  }
  if (servedBy) return `Servi par ${servedBy.machine} (${servedBy.folder}), en ligne`;
  if (agent) return `L'agent du projet ${agent.machine} (${agent.folder}) est hors ligne, les fils attendent`;
  return "Aucun agent ne sert ce projet";
}
