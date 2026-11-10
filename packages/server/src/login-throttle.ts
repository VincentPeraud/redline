const MAX_FAILURES = 5;
/** Failures from one address, whatever the e-mails, before it is locked for the whole window. */
const MAX_FAILURES_PER_IP = 20;
const LOCK_MS = 15 * 60_000;

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

/**
 * Counts failed sign-ins per e-mail and IP: the 5th failure locks that pair for 15 minutes, whether the e-mail exists or not.
 * An address that fails 20 times within 15 minutes, on any e-mails, is locked for all of them.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly addresses = new Map<string, Entry>();

  private key(email: string, ip: string): string {
    return `${ip}|${email.trim().toLowerCase()}`;
  }

  private lockedIn(entries: Map<string, Entry>, key: string): boolean {
    const entry = entries.get(key);
    if (!entry || entry.lockedUntil === 0) return false;
    if (entry.lockedUntil <= Date.now()) {
      entries.delete(key);
      return false;
    }
    return true;
  }

  isLocked(email: string, ip: string): boolean {
    return this.lockedIn(this.addresses, ip) || this.lockedIn(this.entries, this.key(email, ip));
  }

  private count(entries: Map<string, Entry>, key: string, limit: number): void {
    const now = Date.now();
    const known = entries.get(key);
    const entry = known && now - known.lastFailureAt < LOCK_MS ? known : { failures: 0, lockedUntil: 0, lastFailureAt: now };
    entry.failures += 1;
    entry.lastFailureAt = now;
    if (entry.failures >= limit) entry.lockedUntil = now + LOCK_MS;
    entries.set(key, entry);
  }

  /** Forgets what can no longer lock anybody, so the maps do not grow with every stranger. */
  private purge(): void {
    const now = Date.now();
    for (const entries of [this.entries, this.addresses]) {
      for (const [key, entry] of entries) if (entry.lockedUntil !== 0 ? entry.lockedUntil <= now : now - entry.lastFailureAt >= LOCK_MS) entries.delete(key);
    }
  }

  recordFailure(email: string, ip: string): void {
    this.purge();
    this.count(this.entries, this.key(email, ip), MAX_FAILURES);
    this.count(this.addresses, ip, MAX_FAILURES_PER_IP);
  }

  recordSuccess(email: string, ip: string): void {
    this.entries.delete(this.key(email, ip));
  }
}
