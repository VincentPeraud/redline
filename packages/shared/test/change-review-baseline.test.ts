import { describe, expect, it } from "vitest";
import { automaticBaseline, type BaselineVersion } from "@redline/shared";

const at = (day: string) => `2026-11-${day}T10:00:00Z`;
/** A page version made on `day`, by the terminal folder `by` when given (else by a person); `hash` is the artboard's file in it. */
const version = (id: string, day: string, hash: string | undefined, by?: string): BaselineVersion => ({
  id,
  createdAt: at(day),
  origin: by ? "terminal" : "user",
  ...(by ? { originLabel: by } : {}),
  ...(hash ? { hash } : {}),
});

describe("automatic baseline", () => {
  it("starts before the requester's first publish of the artboard in their session", () => {
    const versions = [version("v1", "01", "a"), version("v2", "02", "b", "other-folder"), version("v3", "03", "c", "agora"), version("v4", "04", "d", "agora")];
    expect(automaticBaseline({ versions, requesterFolder: "agora" })).toEqual({ versionId: "v2" });
  });

  it("ignores publishes that did not change the artboard", () => {
    const versions = [version("v1", "01", "a"), version("v2", "02", "a", "agora"), version("v3", "03", "b", "agora")];
    expect(automaticBaseline({ versions, requesterFolder: "agora" })).toEqual({ versionId: "v2" });
  });

  it("falls back to the version before the session's latest publish when it did not publish the artboard", () => {
    const versions = [version("v1", "01", "a"), version("v2", "02", "a", "agora"), version("v3", "03", "a"), version("v4", "04", "a", "agora")];
    expect(automaticBaseline({ versions, requesterFolder: "agora" })).toEqual({ versionId: "v3" });
  });

  it("has no baseline when the requester never published", () => {
    expect(automaticBaseline({ versions: [version("v1", "01", "a")], requesterFolder: "agora" })).toBeUndefined();
  });

  it("is the version right after the last fetched or filed review when there is one, whoever published since", () => {
    const versions = [version("v1", "01", "a", "agora"), version("v2", "05", "b"), version("v3", "09", "c", "agora")];
    expect(automaticBaseline({ versions, requesterFolder: "agora", afterReviewAt: at("06") })).toEqual({ versionId: "v2" });
  });

  it("marks an artboard created in the series as new", () => {
    const versions = [version("v1", "01", undefined), version("v2", "02", "a", "agora")];
    expect(automaticBaseline({ versions, requesterFolder: "agora" })).toBe("new");
  });

  it("marks an artboard created by the very first version as new", () => {
    expect(automaticBaseline({ versions: [version("v1", "01", "a", "agora")], requesterFolder: "agora" })).toBe("new");
  });
});
