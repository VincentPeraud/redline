import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registryPath, type HostAgent } from "./host-protocol.js";

/** The host's agents, persisted in the config directory (no token in it: tokens stay in the logins). */
export class AgentRegistry {
  private readonly file: string;

  constructor(configDir: string) {
    this.file = registryPath(configDir);
  }

  /**
   * Loads the saved agents, all marked stopped: a host that starts never restarts anything by itself.
   * `interrupted` are those recorded as not stopped: the previous host died without stopping them (restart of the Mac, logout).
   */
  load(now: string): { agents: HostAgent[]; interrupted: Set<string> } {
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return { agents: [], interrupted: new Set() };
    }
    if (!Array.isArray(stored)) return { agents: [], interrupted: new Set() };
    const known = stored.filter((entry): entry is HostAgent => typeof entry?.id === "string" && typeof entry?.folder === "string" && typeof entry?.serverUrl === "string");
    return {
      agents: known.map((agent) => ({ ...agent, state: "stopped" as const, since: now, reason: undefined, page: undefined })),
      interrupted: new Set(known.filter((agent) => agent.state !== "stopped").map((agent) => agent.id)),
    };
  }

  save(agents: HostAgent[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(agents, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
