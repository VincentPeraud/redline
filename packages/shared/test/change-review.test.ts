import { describe, expect, it } from "vitest";
import { stepIsModified, mergeSteps, stepLabel, republishedSince, nextReviewState, orderSteps, progressOf, stepKey, reviewResult, stepIsSeen, stepStatus, type ChangeReviewAnswer, type ChangeReviewResultInput } from "@redline/shared";

const ok = (name: string | undefined): ChangeReviewAnswer => ({ id: `a-${name}`, kind: "ok", at: "2026-11-13T10:00:00Z", mine: false, ...(name ? { person: { id: name, name, email: "", initials: name.slice(0, 2) } } : {}) });
const remark = (name: string, text = "Move it up"): ChangeReviewAnswer => ({ ...ok(name), id: `r-${name}`, kind: "remark", text });
const step = (id: string, answers: ChangeReviewAnswer[] = []) => ({ id, answers });

describe("step status", () => {
  it("is not seen without an answer, OK with at least one OK", () => {
    expect(stepStatus([])).toBe("unseen");
    expect(stepStatus([ok("Ana")])).toBe("ok");
    expect(stepStatus([ok("Ana"), ok("Victor")])).toBe("ok");
  });

  it("is Remarque as soon as anyone left a remark, even when others validated", () => {
    expect(stepStatus([remark("Ana")])).toBe("remark");
    expect(stepStatus([ok("Victor"), remark("Ana")])).toBe("remark");
  });

  it("counts a step as seen only when it has an answer", () => {
    expect(stepIsSeen(step("s1"))).toBe(false);
    expect(stepIsSeen(step("s1", [ok("Ana")]))).toBe(true);
  });
});

describe("progress", () => {
  it("counts seen steps and gives one segment per step, the current one marked unless answered", () => {
    const steps = [step("a", [ok("Ana")]), step("b"), step("c"), step("d", [ok("Ana")])];
    expect(progressOf(steps, 1)).toEqual({ seen: 2, total: 4, segments: ["ok", "current", "unseen", "ok"] });
  });

  it("colours a step with a remark as a remark", () => {
    expect(progressOf([step("a", [ok("Ana")]), step("b", [ok("Victor"), remark("Ana")])], 0).segments).toEqual(["ok", "remark"]);
  });

  it("keeps the OK colour on an answered current step", () => {
    expect(progressOf([step("a", [ok("Ana")])], 0).segments).toEqual(["ok"]);
  });
});

describe("removed steps", () => {
  const gone = (id: string, answers: ChangeReviewAnswer[] = []) => ({ id, answers, removed: "deleted" as const });

  it("drops out of the progress count and segments, whatever the current index", () => {
    const steps = [step("a", [ok("Ana")]), gone("b"), step("c")];
    expect(progressOf(steps, 2)).toEqual({ seen: 1, total: 2, segments: ["ok", "current"] });
  });

  it("is not listed as validated or not seen, and its remark comes as text with its reason, unnumbered", () => {
    const result = reviewResult({
      requester: "Ana",
      finishedBy: "Victor",
      steps: [
        { id: "s1", label: "Home · list", artboard: "list.html", answers: [] },
        { id: "s2", label: "Home · empty", artboard: "empty.html", answers: [remark("Ana", "Gone")], removed: "archived" },
        { id: "s3", label: "Home · form", artboard: "form.html", answers: [ok("Ana")] },
      ],
    });

    expect(result.validated).toEqual([{ stepId: "s3", label: "Home · form", number: 2, by: ["Ana"] }]);
    expect(result.notSeen).toEqual([{ stepId: "s1", label: "Home · list", number: 1 }]);
    expect(result.remarks).toEqual([{ stepId: "s2", label: "Home · empty", artboard: "empty.html", author: "Ana", text: "Gone", alsoValidatedBy: [], removed: "archived" }]);
  });
});

describe("step order", () => {
  it("follows the page order, then the reading order of the page", () => {
    const steps = [
      { id: "1", pageId: "p2", artboard: "b.html" },
      { id: "2", pageId: "p1", artboard: "z.html" },
      { id: "3", pageId: "p1", artboard: "a.html" },
      { id: "4", pageId: "p2", artboard: "a.html" },
    ];
    const ordered = orderSteps(steps, ["p1", "p2"], { p1: ["a.html", "z.html"], p2: ["a.html", "b.html"] });
    expect(ordered.map((s) => s.id)).toEqual(["3", "2", "4", "1"]);
  });
});

describe("review result", () => {
  const base = (answers: Record<string, ChangeReviewAnswer[]>): ChangeReviewResultInput => ({
    requester: "Ana",
    finishedBy: "Victor",
    steps: [
      { id: "s1", label: "Home · list", artboard: "list.html", answers: answers.s1 ?? [] },
      { id: "s2", label: "Home · empty", artboard: "empty.html", answers: answers.s2 ?? [] },
    ],
  });

  it("lists the validated steps with who validated them, in step order, and the others as not seen", () => {
    expect(reviewResult(base({ s1: [ok("Ana"), ok("Victor")] }))).toEqual({
      requester: "Ana",
      finishedBy: "Victor",
      validated: [{ stepId: "s1", label: "Home · list", number: 1, by: ["Ana", "Victor"] }],
      remarks: [],
      notSeen: [{ stepId: "s2", label: "Home · empty", number: 2 }],
    });
  });

  it("names an unsigned answer 'someone'", () => {
    expect(reviewResult(base({ s2: [ok(undefined)] })).validated[0]?.by).toEqual(["someone"]);
  });

  it("lists a remark with author, artboard, text, thread and the others who validated the step; the step is not validated", () => {
    const result = reviewResult({ ...base({ s1: [ok("Victor"), remark("Ana", "Too dense")] }), threadIds: { "r-Ana": "thread-1" } });

    expect(result.validated).toEqual([]);
    expect(result.remarks).toEqual([{ stepId: "s1", label: "Home · list", number: 1, artboard: "list.html", author: "Ana", text: "Too dense", alsoValidatedBy: ["Victor"], threadId: "thread-1" }]);
    expect(result.notSeen.map((entry) => entry.stepId)).toEqual(["s2"]);
  });
});

describe("step identity", () => {
  it("is the artboard and its tweak values, whatever the order of the tweaks", () => {
    expect(stepKey({ pageId: "p", artboard: "a.html" })).toBe(stepKey({ pageId: "p", artboard: "a.html", tweaks: {} }));
    expect(stepKey({ pageId: "p", artboard: "a.html", tweaks: { state: "empty", dark: true } })).toBe(stepKey({ pageId: "p", artboard: "a.html", tweaks: { dark: true, state: "empty" } }));
    expect(stepKey({ pageId: "p", artboard: "a.html", tweaks: { state: "empty" } })).not.toBe(stepKey({ pageId: "p", artboard: "a.html", tweaks: { state: "full" } }));
    expect(stepKey({ pageId: "p", artboard: "a.html" })).not.toBe(stepKey({ pageId: "q", artboard: "a.html" }));
  });
});

describe("merging a declaration into an open review", () => {
  const declared = (artboard: string, question: string) => ({ pageId: "p", artboard, changed: "c", lookAt: "l", question });
  const known = (id: string, artboard: string, question: string) => ({ ...declared(artboard, question), id });

  it("keeps the steps already there, adds the new ones, and gives a redeclared step the new texts under its id", () => {
    const merged = mergeSteps([known("s1", "a.html", "old?"), known("s2", "b.html", "b?")], [declared("a.html", "new?"), declared("c.html", "c?")]);

    expect(merged).toEqual([known("s1", "a.html", "new?"), known("s2", "b.html", "b?"), declared("c.html", "c?")]);
  });

  it("treats another tweak state of a known artboard as a new step", () => {
    const merged = mergeSteps([known("s1", "a.html", "q")], [{ ...declared("a.html", "q"), tweaks: { state: "empty" } }]);

    expect(merged.map((s) => s.id)).toEqual(["s1", undefined]);
  });

  it("keeps the example of a group redeclared with another example, and the baselines of its artboards", () => {
    const group = { pageId: "p", artboard: "a.html", changed: "c", lookAt: "l", question: "q", others: [{ pageId: "p", artboard: "b.html", baseline: "vb" }], baseline: "va" };
    const redeclared = { pageId: "p", artboard: "b.html", changed: "c", lookAt: "l", question: "new?", others: [{ pageId: "p", artboard: "a.html", baseline: "va" }], baseline: "vb" };

    const [merged] = mergeSteps([{ ...group, id: "g1" }], [redeclared]);

    expect(merged).toEqual({ ...group, question: "new?", id: "g1" });
  });

  it("keeps the last of two declarations of the same step", () => {
    expect(mergeSteps([], [declared("a.html", "first?"), declared("a.html", "second?")])).toEqual([declared("a.html", "second?")]);
  });
});

describe("steps modified after an answer", () => {
  const old = (answer: ChangeReviewAnswer): ChangeReviewAnswer => ({ ...answer, outdated: true });

  it("ignores an OK on an older version: the step is not seen and is modified", () => {
    expect(stepStatus([old(ok("Ana"))])).toBe("unseen");
    expect(stepIsSeen(step("s", [old(ok("Ana"))]))).toBe(false);
    expect(stepIsModified(step("s", [old(ok("Ana"))]))).toBe(true);
  });

  it("keeps an outdated remark as a remark, and counts it as seen", () => {
    expect(stepStatus([old(remark("Ana"))])).toBe("remark");
    expect(stepIsSeen(step("s", [old(remark("Ana"))]))).toBe(true);
    expect(stepIsModified(step("s", [old(remark("Ana"))]))).toBe(true);
  });

  it("is not modified when someone answered the current version", () => {
    const answers = [old(ok("Ana")), ok("Victor")];
    expect(stepIsModified(step("s", answers))).toBe(false);
    expect(stepStatus(answers)).toBe("ok");
    expect(stepIsModified(step("s"))).toBe(false);
  });

  it("gives a modified step a red segment", () => {
    expect(progressOf([step("a", [old(ok("Ana"))]), step("b", [ok("Ana")]), step("c", [old(remark("Ana"))])], 0)).toEqual({ seen: 2, total: 3, segments: ["modified", "ok", "modified"] });
  });

  it("lists a step with only outdated OKs as not seen, modified after the OK, and marks an outdated remark", () => {
    const result = reviewResult({
      requester: "Ana",
      finishedBy: "Victor",
      steps: [
        { id: "s1", label: "Home · list", artboard: "list.html", answers: [old(ok("Ana"))] },
        { id: "s2", label: "Home · empty", artboard: "empty.html", answers: [old(remark("Ana")), ok("Victor")] },
        { id: "s3", label: "Home · other", artboard: "other.html", answers: [] },
      ],
    });
    expect(result.notSeen).toEqual([{ stepId: "s1", label: "Home · list", number: 1, modifiedAfterOk: true }, { stepId: "s3", label: "Home · other", number: 3 }]);
    expect(result.validated).toEqual([]);
    expect(result.remarks).toMatchObject([{ stepId: "s2", artboardModified: true, alsoValidatedBy: ["Victor"] }]);
  });
});

describe("grouped steps", () => {
  const ref = (pageId: string, artboard: string) => ({ pageId, artboard });

  it("identifies a group by its set of artboards: one of them alone is another step, whichever is the example", () => {
    const group = { ...ref("p1", "a.html"), others: [ref("p1", "b.html"), ref("p2", "c.html")] };
    expect(stepKey(group)).toBe(stepKey({ ...ref("p2", "c.html"), others: [ref("p1", "b.html"), ref("p1", "a.html")] }));
    expect(stepKey(group)).not.toBe(stepKey(ref("p1", "a.html")));
    expect(stepKey(ref("p1", "b.html"))).not.toBe(stepKey({ ...ref("p1", "a.html"), others: [ref("p1", "b.html")] }));
  });

  it("names a group with its size and a single step with its page and artboard", () => {
    expect(stepLabel({ title: "Badge cmux", pageTitle: "Home", artboardTitle: "List", others: new Array(16).fill(0) })).toBe("Badge cmux (17 artboards)");
    expect(stepLabel({ pageTitle: "Home", artboardTitle: "List", others: [{}, {}] })).toBe("Home · List (3 artboards)");
    expect(stepLabel({ pageTitle: "Home", artboardTitle: "List" })).toBe("Home · List");
  });

  it("puts a single-page group at its first artboard and multi-page groups last", () => {
    const steps = [
      { id: "multi", ...ref("p1", "a.html"), others: [ref("p2", "a.html")] },
      { id: "single", ...ref("p2", "b.html") },
      { id: "group", ...ref("p1", "z.html"), others: [ref("p1", "b.html")] },
      { id: "first", ...ref("p1", "a.html") },
      { id: "alone", ...ref("p1", "c.html") },
      { id: "multi2", ...ref("p2", "a.html"), others: [ref("p1", "c.html")] },
    ];
    const ordered = orderSteps(steps, ["p1", "p2"], { p1: ["a.html", "b.html", "c.html", "z.html"], p2: ["a.html", "b.html"] });
    expect(ordered.map((s) => s.id)).toEqual(["first", "group", "alone", "single", "multi", "multi2"]);
  });

  it("finds which artboards were republished since an answer saw them", () => {
    const seen = { artboardVersion: "v1", memberVersions: { b: "v1", c: "v2" } };
    expect(republishedSince(seen, { example: "v1", others: { b: "v1", c: "v2" } })).toEqual({ example: false, others: [] });
    expect(republishedSince(seen, { example: "v1", others: { b: "v3", c: "v2" } })).toEqual({ example: false, others: ["b"] });
    expect(republishedSince(seen, { example: "v4", others: { b: "v1", c: undefined } })).toEqual({ example: true, others: [] });
    expect(republishedSince({}, { example: "v4", others: { b: "v1" } })).toEqual({ example: false, others: [] });
  });

  it("attaches a group remark to its artboard and cites the others in the result", () => {
    const members = [
      { pageId: "p1", artboard: "a.html", label: "Home · a" },
      { pageId: "p1", artboard: "b.html", label: "Home · b" },
      { pageId: "p2", artboard: "c.html", label: "Settings · c" },
    ];
    const onB = { ...remark("Ana"), on: { pageId: "p1", artboard: "b.html" } };
    const result = reviewResult({ requester: "Ana", finishedBy: "Ana", steps: [{ id: "g", label: "Badge (3 artboards)", artboard: "a.html", members, answers: [onB, remark("Victor")] }] });
    expect(result.remarks).toMatchObject([
      { author: "Ana", artboard: "b.html", onLabel: "Home · b", alsoOn: ["Home · a", "Settings · c"] },
      { author: "Victor", artboard: "a.html", onLabel: "Home · a", alsoOn: ["Home · b", "Settings · c"] },
    ]);
  });
});

describe("allowed transitions", () => {
  it("finishes an open review, and nothing else leaves open", () => {
    expect(nextReviewState("open", "finish")).toBe("finished");
    expect(nextReviewState("open", "reopen")).toBeUndefined();
    expect(nextReviewState("open", "file")).toBeUndefined();
    expect(nextReviewState("open", "fetch")).toBeUndefined();
  });

  it("reopens, files or fetches a finished review", () => {
    expect(nextReviewState("finished", "reopen")).toBe("open");
    expect(nextReviewState("finished", "file")).toBe("filed");
    expect(nextReviewState("finished", "fetch")).toBe("fetched");
    expect(nextReviewState("finished", "finish")).toBeUndefined();
  });

  it("cannot reopen a fetched review, and filing is final", () => {
    expect(nextReviewState("fetched", "reopen")).toBeUndefined();
    expect(nextReviewState("fetched", "file")).toBeUndefined();
    for (const action of ["finish", "reopen", "file", "fetch"] as const) expect(nextReviewState("filed", action)).toBeUndefined();
  });
});
