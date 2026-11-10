import type { SessionFilter, SessionRow, SessionStatus } from "@redline/shared";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "En cours",
  queued: "En file",
  "waiting-agent": "Attend l'agent",
  held: "En attente d'envoi",
  answered: "Répondu",
  resolved: "Résolu",
  archived: "Archivée",
  failed: "Échec",
  idle: "Aucun message",
};

export const FILTER_LABEL: Record<SessionFilter, string> = {
  all: "Toutes",
  running: "En cours",
  waiting: "En attente",
  answered: "Répondues",
  resolved: "Résolues",
  failed: "Échecs",
};

/** "b41f…07d" for a long engine session id; "—" before the first run. */
export function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) return "—";
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 4)}…${sessionId.slice(-3)}`;
}

/** "model · effort · context %", "—" for what is not known yet. */
export function modelLine(row: SessionRow): string {
  if (!row.model && !row.effort && !row.context) return "—";
  return [row.model, row.effort, row.context && `${row.context.percent} %`].filter(Boolean).join(" · ");
}

export function agentName(row: SessionRow): string {
  if (!row.agent) return "—";
  return row.agent.kind === "global" ? "global" : row.agent.folder.split("/").filter(Boolean).pop() ?? row.agent.machine;
}

/** "à l'instant", "il y a 5 min", "il y a 3 h", "hier", "il y a 4 jours". */
export function activityLabel(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "hier" : `il y a ${days} jours`;
}

export const WAITING_NOTE: Record<NonNullable<SessionRow["waitingReason"]>, string> = {
  "page-busy": "En file : traité dès que la session en cours sur cette page est terminée, pour ne pas modifier la même page en même temps.",
  "agent-offline": "Aucun agent ne tourne pour ce projet : le fil part dès qu'un agent est lancé dans son dossier.",
  "project-archived": "Le projet est archivé : le fil partira s'il est désarchivé.",
  "page-archived": "La page est archivée : le fil partira si elle est désarchivée.",
  terminal: "En file : en attente de la session terminal, à qui le fil est confié tant qu'elle garde la page ; il part à l'agent si elle se ferme.",
  "design-system-agent-offline": "Aucun agent ne tourne pour les projets qui utilisent ce design system : le fil part dès que l'agent de l'un d'eux est lancé.",
  retrying: "Échec temporaire : nouvelle tentative programmée.",
};
