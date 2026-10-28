import type { ScreenTerminal } from "./agents-screen.js";

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";

const KEYS: Record<string, string> = { "\x1b[A": "up", "\x1b[B": "down", "\x1bOA": "up", "\x1bOB": "down", "\x03": "ctrl-c", "\x1b": "escape" };

/** The real terminal: alternate screen, raw keys, resize. Restored by `close`, and also if the process exits without it (a crash). */
export function openTerminal(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): ScreenTerminal {
  let keyListener: (key: string) => void = () => undefined;
  let resizeListener: () => void = () => undefined;
  const onData = (data: Buffer) => {
    const text = data.toString("utf8");
    keyListener(KEYS[text] ?? text);
  };
  const onResize = () => resizeListener();
  let open = true;
  const restore = () => {
    if (!open) return;
    open = false;
    input.off("data", onData);
    output.off("resize", onResize);
    process.off("exit", restore);
    input.setRawMode(false);
    input.pause();
    output.write(LEAVE_SCREEN);
  };

  output.write(ENTER_SCREEN);
  input.setRawMode(true);
  input.resume();
  input.on("data", onData);
  output.on("resize", onResize);
  process.on("exit", restore);

  return {
    size: () => ({ columns: output.columns, rows: output.rows }),
    // Each line is positioned absolutely and ends with a clear, so a shorter line never leaves the previous frame behind.
    draw: (lines) => output.write(lines.map((line, index) => `\x1b[${index + 1};1H${line}\x1b[K`).join("")),
    onKey: (listener) => (keyListener = listener),
    onResize: (listener) => (resizeListener = listener),
    close: restore,
  };
}
