/** Waits before retrying a failed work item: 1, 5 and 15 minutes, then the item is failed for good. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000];

/** Wait when a subscription limit is reported without a usable reset time. */
export const UNKNOWN_RESET_WAIT_MS = 15 * 60_000;

/**
 * UNVERIFIED: how Claude Code words a subscription-limit error is a guess (no limit was ever recorded in a fixture).
 * These three patterns are the only place that guess lives; replace them when a real message is captured
 * (see "Subscription limit messages" in docs/claude-code-engine.md). An unrecognised limit just follows the retry ladder.
 */
const LIMIT_PATTERN = /usage limit|hit your limit|limit reached|rate limit|limit will reset/i;
const EPOCH_PATTERN = /limit reached\s*\|\s*(\d{9,13})/i;
const CLOCK_PATTERN = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

export function isSubscriptionLimit(message: string): boolean {
  return LIMIT_PATTERN.test(message);
}

/**
 * When a subscription-limit message says the limit resets, as epoch milliseconds: either
 * "...limit reached|<epoch seconds>" or "resets 3pm" / "resets 15:30" (next occurrence, server time).
 */
export function limitResetAt(message: string, now = Date.now()): number | undefined {
  const epoch = EPOCH_PATTERN.exec(message)?.[1];
  if (epoch) return epoch.length > 11 ? Number(epoch) : Number(epoch) * 1000;
  const clock = CLOCK_PATTERN.exec(message);
  if (!clock) return undefined;
  let hours = Number(clock[1]);
  const meridiem = clock[3]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23) return undefined;
  const reset = new Date(now);
  reset.setHours(hours, Number(clock[2] ?? 0), 0, 0);
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}
