/** Newline-delimited JSON, as the host and its clients speak it on the control socket. */

/** The longest line a peer may send; a longer one without its newline is a peer to drop. */
export const MAX_LINE_LENGTH = 1_000_000;

export const encodeLine = (message: unknown): string => `${JSON.stringify(message)}\n`;

/**
 * Feeds chunks, calls `onLine` with each non-blank line. Returns false once a line grows beyond `maxLength` without its
 * newline: the caller drops the connection.
 */
export function lineReader(onLine: (line: string) => void, maxLength = MAX_LINE_LENGTH): (chunk: string) => boolean {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
    return buffer.length <= maxLength;
  };
}
