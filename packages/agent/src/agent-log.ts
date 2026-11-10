import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HostLogEntry } from "./host-protocol.js";

export const DEFAULT_LOG_CAP = 1000;

/** An agent's run log: one JSON entry per line in a file, kept to the last `cap` entries (oldest dropped). */
export class AgentLog {
  private entries: HostLogEntry[] | undefined;
  private secured = false;

  constructor(
    private readonly file: string,
    private readonly cap: number,
  ) {}

  private load(): HostLogEntry[] {
    if (this.entries) return this.entries;
    try {
      this.entries = readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as HostLogEntry)
        .slice(-this.cap);
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  append(entry: HostLogEntry): void {
    const entries = this.load();
    entries.push(entry);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // `mode` only applies to a file that is created: tighten one that was already there.
    if (!this.secured && existsSync(this.file)) chmodSync(this.file, 0o600);
    this.secured = true;
    if (entries.length > this.cap) {
      entries.splice(0, entries.length - this.cap);
      writeFileSync(this.file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    } else appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Deletes the log file; the log is empty afterwards. */
  delete(): void {
    this.entries = [];
    rmSync(this.file, { force: true });
  }

  /** The last `lines` entries (all by default), oldest first. */
  read(lines?: number): HostLogEntry[] {
    const entries = this.load();
    return lines === undefined ? [...entries] : lines <= 0 ? [] : entries.slice(-lines);
  }
}
