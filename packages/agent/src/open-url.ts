import { spawn } from "node:child_process";

/** Opens an address with the system's opener, detached: the screen does not wait for the browser. */
export function openWithSystem(url: string, platform: NodeJS.Platform = process.platform): void {
  const opener = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
