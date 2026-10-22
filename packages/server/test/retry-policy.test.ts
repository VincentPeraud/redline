import { describe, expect, it } from "vitest";
import { isSubscriptionLimit, limitResetAt } from "../src/retry-policy.js";

describe("subscription limit messages", () => {
  it("recognises a limit and reads an epoch reset time", () => {
    const message = "Claude AI usage limit reached|1900000000";
    expect(isSubscriptionLimit(message)).toBe(true);
    expect(limitResetAt(message)).toBe(1_900_000_000_000);
  });

  it("reads a clock reset time as the next occurrence", () => {
    const now = new Date(2026, 0, 10, 16, 0).getTime();
    expect(limitResetAt("You've hit your limit · resets 3pm", now)).toBe(new Date(2026, 0, 11, 15, 0).getTime());
    expect(limitResetAt("You've hit your limit · resets 17:30", now)).toBe(new Date(2026, 0, 10, 17, 30).getTime());
  });

  it("does not take another error for a limit", () => {
    expect(isSubscriptionLimit("Overloaded")).toBe(false);
    expect(limitResetAt("Overloaded")).toBeUndefined();
  });
});
