/**
 * Text from the server (titles, authors, excerpts, reasons) is shown on the user's terminal: a control character in it could
 * move the cursor, rewrite the screen or set the window title. Line breaks and tabs become spaces, other control characters
 * (C0, DEL, C1, which includes the escape character) are dropped.
 */
export const sanitizeForTerminal = (text: string): string => text.replace(/[\n\r\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");

const MAX_INSTANCE_NAME_LENGTH = 60;

/** An instance name received from a server: shown in many places and turned into a folder id, so it is cleaned and cut on receipt. */
export const receivedInstanceName = (name: string): string => sanitizeForTerminal(name).trim().slice(0, MAX_INSTANCE_NAME_LENGTH).trim();
