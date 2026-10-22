import type { HTMLAttributes } from "react";
import type { SessionStatus } from "@redline/shared";
import { cx } from "./cx.js";
import styles from "./StatusBadge.module.css";

/** running: red fill; warning: waiting or held; neutral: grey chip; success: green; muted: finished; danger: failure. */
export type BadgeTone = "running" | "warning" | "neutral" | "success" | "muted" | "danger";

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone: BadgeTone;
  /** md: table rows and cards; sm: panel headers. */
  size?: "md" | "sm";
}

export function StatusBadge({ tone, size = "md", className, ...rest }: StatusBadgeProps) {
  return <span className={cx(styles.badge, styles[tone], styles[size], className)} {...rest} />;
}

export const SESSION_STATUS_TONE: Record<SessionStatus, BadgeTone> = {
  running: "running",
  queued: "warning",
  "waiting-agent": "neutral",
  held: "warning",
  answered: "success",
  resolved: "muted",
  archived: "muted",
  failed: "danger",
  idle: "muted",
};

/** French label of each session status (En cours, En file, Attend l'agent, En attente d'envoi, Répondu, Résolu, Échec...). */
export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
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

/** Badge of a session status with its standard tone and label. */
export function SessionStatusBadge({ status, ...rest }: { status: SessionStatus } & Omit<StatusBadgeProps, "tone" | "children">) {
  return (
    <StatusBadge tone={SESSION_STATUS_TONE[status]} {...rest}>
      {SESSION_STATUS_LABEL[status]}
    </StatusBadge>
  );
}
