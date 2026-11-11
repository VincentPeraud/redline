import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sessionsDir = (installationDir: string) => join(installationDir, "sessions");

/**
 * The launcher notes each live Claude Code session of an installation (one file per process) so that `remove` knows the files are
 * in use. Returns the function that forgets the session; it also runs when the process exits.
 */
export function recordSession(installationDir: string, folder: string): () => void {
  const file = join(sessionsDir(installationDir), `${process.pid}.json`);
  mkdirSync(sessionsDir(installationDir), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, folder }));
  const forget = () => rmSync(file, { force: true });
  process.once("exit", forget);
  return () => {
    process.removeListener("exit", forget);
    forget();
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The sessions whose process still runs; the notes of dead ones (a crash left them) are dropped. */
export function liveSessions(installationDir: string): { pid: number; folder: string }[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(installationDir));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(sessionsDir(installationDir), name);
    try {
      const { pid, folder } = JSON.parse(readFileSync(file, "utf8")) as { pid: number; folder: string };
      if (alive(pid)) return [{ pid, folder }];
    } catch {
      // unreadable note: dropped like a dead one
    }
    rmSync(file, { force: true });
    return [];
  });
}
