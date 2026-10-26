import { createInterface } from "node:readline";

export interface SecretPromptIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
  output: { write(text: string): unknown };
}

/**
 * Asks for a secret in the terminal, echoing one star per character so a pasted token never shows on screen.
 * Outside a terminal (a piped secret), reads the first line as is.
 */
export function askSecret(question: string, io: SecretPromptIo = { input: process.stdin, output: process.stdout }): Promise<string> {
  const { input, output } = io;
  output.write(question);
  if (!input.isTTY || !input.setRawMode) return firstLine(input);
  const setRawMode = input.setRawMode.bind(input);
  return new Promise((resolve, reject) => {
    let secret = "";
    const finish = (error?: Error) => {
      input.removeListener("data", onData);
      setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(secret);
    };
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      // Arrow keys and other escape sequences arrive as one chunk: they never belong to the secret.
      if (text.startsWith("\u001b")) return;
      for (const char of text) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") {
          if (secret) {
            secret = secret.slice(0, -1);
            output.write("\b \b");
          }
        } else if (char >= " ") {
          secret += char;
          output.write("*");
        }
      }
    };
    setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
}

function firstLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, terminal: false });
    let line = "";
    rl.once("line", (first) => {
      line = first;
      rl.close();
    });
    rl.once("close", () => resolve(line));
  });
}
