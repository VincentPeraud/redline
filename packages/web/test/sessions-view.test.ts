import { describe, expect, it } from "vitest";
import { activityLabel, shortSessionId } from "../src/sessionsView";

describe("sessions view helpers", () => {
  it("shortens engine session ids", () => {
    expect(shortSessionId("b41f2c10-aaaa-bbbb-cccc-0123456789d7")).toBe("b41f…9d7");
    expect(shortSessionId(undefined)).toBe("—");
  });

  it("words the activity relative to now", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(activityLabel(ago(10_000), now)).toBe("à l'instant");
    expect(activityLabel(ago(5 * 60_000), now)).toBe("il y a 5 min");
    expect(activityLabel(ago(3 * 3_600_000), now)).toBe("il y a 3 h");
    expect(activityLabel(ago(30 * 3_600_000), now)).toBe("hier");
    expect(activityLabel(ago(50 * 3_600_000), now)).toBe("il y a 2 jours");
  });
});
