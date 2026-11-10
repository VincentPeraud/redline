import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { hostLockPath, hostSocketPath } from "./host-protocol.js";

export class HostAlreadyRunningError extends Error {
  constructor() {
    super("An agent host is already running.");
  }
}

/** A lock whose content is not a pid yet may be one being written: it is a live host's for this long. */
const UNREADABLE_LOCK_GRACE_MS = 5000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The directory of the host's socket and lock: only this user can enter it, whatever the mode of the config directory around it.
 * It is created private, and a leftover is checked (a directory, not a link, ours) and tightened before anything goes in it.
 */
export function prepareHostDirectory(configDir: string): void {
  const directory = dirname(hostSocketPath(configDir));
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const found = lstatSync(directory);
  if (!found.isDirectory() || found.isSymbolicLink() || (process.getuid && found.uid !== process.getuid())) {
    throw new Error(`${directory} is not a directory of yours: remove it and start again.`);
  }
  if ((found.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
}

/** What the lock file says, or undefined when it is gone (its host just left). */
function readLock(lock: string): string | undefined {
  try {
    return readFileSync(lock, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * One host per config directory. The lock file holds the pid of the running host and appears atomically, already holding it
 * (written aside, then linked into place). The lock of a dead pid is taken over. Returns the release, which removes the lock
 * only while it still holds this pid.
 */
export function acquireLock(configDir: string): () => void {
  const lock = hostLockPath(configDir);
  const mine = String(process.pid);
  const aside = `${lock}.${randomBytes(6).toString("hex")}`;
  writeFileSync(aside, mine, { mode: 0o600 });
  try {
    for (;;) {
      try {
        linkSync(aside, lock);
        return () => {
          if (readLock(lock) === mine) rmSync(lock, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const content = readLock(lock);
      if (content === undefined) continue;
      const pid = Number(content);
      const recent = Date.now() - statSync(lock).mtimeMs < UNREADABLE_LOCK_GRACE_MS;
      if (Number.isInteger(pid) && pid > 0 ? isAlive(pid) : recent) throw new HostAlreadyRunningError();
      rmSync(lock, { force: true });
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

/** Frees the socket path for this host: a socket nobody answers on is a dead host's leftover; one that answers is a live host's. */
export async function claimSocket(configDir: string): Promise<void> {
  const path = hostSocketPath(configDir);
  const outcome = await new Promise<"answers" | "free" | Error>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve("answers");
    });
    probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "free" : error));
  });
  if (outcome instanceof Error) throw outcome;
  if (outcome === "answers") throw new HostAlreadyRunningError();
  rmSync(path, { force: true });
}
