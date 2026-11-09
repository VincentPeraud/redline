const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/** Counts failed sign-ins per e-mail and IP: the 5th failure locks that pair for 15 minutes, whether the e-mail exists or not. */
export class LoginThrottle {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();

  private key(email: string, ip: string): string {
    return `${ip}|${email.trim().toLowerCase()}`;
  }

  isLocked(email: string, ip: string): boolean {
    const key = this.key(email, ip);
    const entry = this.entries.get(key);
    if (!entry || entry.lockedUntil === 0) return false;
    if (entry.lockedUntil <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  recordFailure(email: string, ip: string): void {
    const key = this.key(email, ip);
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= MAX_FAILURES) entry.lockedUntil = Date.now() + LOCK_MS;
    this.entries.set(key, entry);
  }

  recordSuccess(email: string, ip: string): void {
    this.entries.delete(this.key(email, ip));
  }
}
