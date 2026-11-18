/** A terminal session with no heartbeat for this long is gone. */
export const TERMINAL_PRESENCE_TIMEOUT_MS = 60_000;

/** `/Users/ana/work/site` (or `/home/ana/…`, `C:\Users\ana\…`) shows as `~/work/site`: the login is not served. */
const HOME_PREFIX = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;
export const homeShortened = (folder: string) => folder.replace(HOME_PREFIX, "~");

interface Presence {
  /** The account whose token the session uses. */
  personId?: string;
  folder: string;
  machine: string;
  lastSeen: number;
}

/** Where a conversation works and for which account: what a take is labelled with. */
export interface SessionLabel {
  /** "" without SSO (the shared token is one account). */
  accountId: string;
  /** Home shortened. */
  folder: string;
  machine: string;
}

/**
 * Which terminal sessions (`redline mcp`, one per Claude Code conversation process) are present, kept in memory from their heartbeats.
 * A session carries its account, folder and machine, which label what it takes. Presence drives nothing else: the take belongs to the
 * account, so a thread stays answerable after the process that took it is gone.
 */
export class TerminalSessions {
  private readonly present = new Map<string, Presence>();
  /** The account (or "" for the shared token) that first used each session id: nobody else may use it. */
  private readonly owners = new Map<string, { personId: string; since: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly timeoutMs: number = TERMINAL_PRESENCE_TIMEOUT_MS) {
    this.timer = setInterval(() => this.sweep(), Math.max(20, Math.floor(timeoutMs / 4)));
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** Binds the session id to the first account that uses it; false for any other account. */
  claim(sessionId: string, personId: string | undefined): boolean {
    const owner = this.owners.get(sessionId);
    if (!owner) this.owners.set(sessionId, { personId: personId ?? "", since: Date.now() });
    return owner === undefined || owner.personId === (personId ?? "");
  }

  heartbeat(sessionId: string, folder: string, machine: string, personId?: string): void {
    this.present.set(sessionId, { personId, folder, machine, lastSeen: Date.now() });
  }

  bye(sessionId: string): void {
    this.owners.delete(sessionId);
    this.present.delete(sessionId);
  }

  /** The account was deactivated: its sessions leave. */
  releaseSessionsOf(personId: string): void {
    for (const [sessionId, session] of this.present) {
      if (session.personId !== personId) continue;
      this.present.delete(sessionId);
      this.owners.delete(sessionId);
    }
  }

  isPresent(sessionId: string): boolean {
    return this.present.has(sessionId);
  }

  /** The folder a present session works in, shortened. */
  folderOf(sessionId: string): string | undefined {
    const session = this.present.get(sessionId);
    return session && homeShortened(session.folder);
  }

  /** The label of a present session; undefined once it is gone. */
  labelOf(sessionId: string): SessionLabel | undefined {
    const session = this.present.get(sessionId);
    return session && { accountId: session.personId ?? "", folder: homeShortened(session.folder), machine: session.machine };
  }

  /** Forgets the sessions without a recent heartbeat. */
  sweep(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.present) {
      if (now - session.lastSeen <= this.timeoutMs) continue;
      this.present.delete(sessionId);
      this.owners.delete(sessionId);
    }
    // A session id claimed but never seen (no heartbeat) is forgotten after the same delay.
    for (const [sessionId, owner] of this.owners) if (!this.present.has(sessionId) && now - owner.since > this.timeoutMs) this.owners.delete(sessionId);
  }
}
