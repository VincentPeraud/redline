import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registryPath, type HostAgent } from "./host-protocol.js";

/** The host's agents, persisted in the config directory (no token in it: tokens stay in the logins). */
export class AgentRegistry {
  private readonly file: string;

  constructor(configDir: string) {
    this.file = registryPath(configDir);
  }

  /** Loads the saved agents, all marked stopped: a host that starts never restarts anything by itself. */
  load(now: string): HostAgent[] {
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((entry): entry is HostAgent => typeof entry?.id === "string" && typeof entry?.folder === "string" && typeof entry?.serverUrl === "string")
      .map((agent) => ({ ...agent, state: "stopped" as const, since: now, reason: undefined }));
  }

  save(agents: HostAgent[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(agents, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
