import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeReviewStore, REVIEW_PRESENCE_TIMEOUT_MS } from "../src/change-review-store.js";

afterEach(() => vi.useRealTimers());

describe("review presence", () => {
  it("forgets the people not heard from and the reviews nobody is on, so the map does not grow", () => {
    vi.useFakeTimers();
    const store = new ChangeReviewStore(new Database(":memory:"));
    const presence = (store as unknown as { presence: Map<string, Map<string, unknown>> }).presence;
    store.markPresent("review-1", "ana", 1);
    store.markPresent("review-2", "victor", undefined);

    vi.advanceTimersByTime(REVIEW_PRESENCE_TIMEOUT_MS + 1);
    store.markPresent("review-3", "ana", 2);

    expect([...presence.keys()]).toEqual(["review-3"]);
    expect(store.presentIn("review-3", undefined)).toEqual([{ personId: "ana", step: 2 }]);
  });
});
