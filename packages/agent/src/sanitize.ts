/**
 * Text from the server (titles, authors, excerpts, reasons) is shown on the user's terminal: a control character in it could
 * move the cursor, rewrite the screen or set the window title. Line breaks and tabs become spaces, other control characters
 * (C0, DEL, C1, which includes the escape character) are dropped.
 */
export const sanitizeForTerminal = (text: string): string => text.replace(/[\n\r\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
