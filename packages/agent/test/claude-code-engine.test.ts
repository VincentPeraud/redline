import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@redline/shared";
import { buildClaudeArgs, claudeCodeEngine, createStreamParser } from "../src/claude-code-engine.js";
import type { EngineRunRequest } from "../src/engine.js";

const fixturesDir = join(import.meta.dirname, "fixtures", "claude-stream");
const fixture = (name: string) => join(fixturesDir, `${name}.jsonl`);

function parseFixture(name: string, cwd = "/work"): EngineEvent[] {
  const parser = createStreamParser(cwd);
  const events = readFileSync(fixture(name), "utf8")
    .split("\n")
    .flatMap((line) => parser.push(line));
  return [...events, ...parser.end("")];
}

const request: EngineRunRequest = {
  sessionId: "11111111-2222-4333-8444-555555555555",
  message: "Make the button red",
  cwd: "/work",
  workingCopyDir: "/work/.redline/page-1",
  mcpUrl: "http://127.0.0.1:4555/mcp",
};

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("Claude Code argument building", () => {
  it("starts a session with --session-id and streams json without a prompt on the command line", () => {
    const args = buildClaudeArgs(request, "start");
    expect(args[0]).toBe("-p");
    expect(valueAfter(args, "--session-id")).toBe(request.sessionId);
    expect(args).not.toContain("--resume");
    expect(valueAfter(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain(request.message);
  });

  it("resumes a session with --resume", () => {
    const args = buildClaudeArgs(request, "resume");
    expect(valueAfter(args, "--resume")).toBe(request.sessionId);
    expect(args).not.toContain("--session-id");
  });

  it("passes model and effort only when given, independently", () => {
    const bare = buildClaudeArgs(request, "start");
    expect(bare).not.toContain("--model");
    expect(bare).not.toContain("--effort");

    const modelOnly = buildClaudeArgs({ ...request, model: "opus" }, "start");
    expect(valueAfter(modelOnly, "--model")).toBe("opus");
    expect(modelOnly).not.toContain("--effort");

    const effortOnly = buildClaudeArgs({ ...request, effort: "xhigh" }, "resume");
    expect(valueAfter(effortOnly, "--effort")).toBe("xhigh");
    expect(effortOnly).not.toContain("--model");

    const both = buildClaudeArgs({ ...request, model: "sonnet", effort: "low" }, "resume");
    expect(valueAfter(both, "--model")).toBe("sonnet");
    expect(valueAfter(both, "--effort")).toBe("low");
  });

  it("never prompts and allows writes only inside the working copy, plus Redline's MCP tools", () => {
    const args = buildClaudeArgs(request, "start");
    expect(valueAfter(args, "--permission-mode")).toBe("dontAsk");
    const allowed = valueAfter(args, "--allowedTools")!.split(",");
    expect(allowed).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit(/.redline/page-1/**)",
      "Write(/.redline/page-1/**)",
      "mcp__redline",
    ]);
    const denied = valueAfter(args, "--disallowedTools")!.split(",");
    expect(denied).toContain("Bash");
    expect(denied).toContain("NotebookEdit");
    expect(JSON.parse(valueAfter(args, "--mcp-config")!)).toEqual({
      mcpServers: { redline: { type: "http", url: request.mcpUrl } },
    });
  });

  it("refuses a working copy outside the agent's folder", () => {
    expect(() => buildClaudeArgs({ ...request, workingCopyDir: "/elsewhere/page-1" }, "start")).toThrow(
      "inside the agent's folder",
    );
  });
});

describe("Claude Code stream-json parsing (recorded fixtures)", () => {
  it("maps a session that reads, writes, gets a denied write and answers", () => {
    const events = parseFixture("edit-and-denied-write");

    expect(events.filter((e) => e.type === "step")).toEqual([
      { type: "step", tool: "Read", summary: "readme.txt" },
      { type: "step", tool: "Write", summary: ".redline/p1/a.txt" },
      { type: "step", tool: "Write", summary: "outside.txt" },
    ]);

    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("outside.txt");

    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(4);
    expect(usage[0]).toMatchObject({ type: "usage", model: "claude-haiku-5-5", inputTokens: 2, cacheTokens: 23599 + 12789, outputTokens: 239 });
    expect(usage[3]).toEqual({
      type: "usage",
      model: "claude-haiku-5-5",
      inputTokens: 2,
      cacheTokens: 551 + 36946,
      outputTokens: 273,
    });

    const last = events[events.length - 1];
    expect(last.type).toBe("result");
    expect((last as { summary: string }).summary).toContain("Ce qui s'est passé");
    expect(events.filter((e) => e.type === "result" || e.type === "error")).toHaveLength(1);
  });

  it("maps a resumed turn the same way", () => {
    const events = parseFixture("resume-ok");
    expect(events.at(-1)).toEqual({ type: "result", summary: "readme.txt", contextWindow: 1_000_000 });
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  it("reports resuming an unknown session as an error", () => {
    expect(parseFixture("resume-unknown-session")).toEqual([
      { type: "error", message: "No conversation found with session ID: 99999999-2222-4333-8444-555555555555" },
    ]);
  });

  it("reports an API failure (unknown model) as an error even when the subtype says success", () => {
    const events = parseFixture("unknown-model");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("nonexistent-xyz");
  });

  it("reports a stream that ends without a result as an error carrying the stderr", () => {
    const parser = createStreamParser("/work");
    expect(parser.push("not json")).toEqual([]);
    expect(parser.end("boom")).toEqual([{ type: "error", message: "boom" }]);
    expect(createStreamParser("/work").end("")).toEqual([
      { type: "error", message: "Claude Code ended without a result." },
    ]);
  });
});

describe("Claude Code process", () => {
  function fakeClaude(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "redline-fake-claude-"));
    const file = join(dir, "claude");
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  function realFolderRequest(): EngineRunRequest {
    const cwd = mkdtempSync(join(tmpdir(), "redline-cwd-"));
    return { ...request, cwd, workingCopyDir: join(cwd, ".redline", "page-1") };
  }

  async function collect(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    for await (const event of iterable) events.push(event);
    return events;
  }

  it("feeds the message on stdin, runs in the agent's folder and streams the recorded events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "redline-cwd-"));
    const seen = join(cwd, "seen.txt");
    const command = fakeClaude(`cat > seen.txt\npwd >> seen.txt\ncat "${fixture("resume-ok")}"`);
    const engine = claudeCodeEngine({ command });

    const events = await collect(engine.resume({ ...request, cwd, workingCopyDir: join(cwd, ".redline", "page-1") }));

    expect(events.at(-1)).toEqual({ type: "result", summary: "readme.txt", contextWindow: 1_000_000 });
    const record = readFileSync(seen, "utf8");
    expect(record.startsWith("Make the button red")).toBe(true);
    expect(record).toContain("redline-cwd-");
  });

  it("reports a crash without any result with the stderr", async () => {
    const command = fakeClaude("echo 'auth expired' >&2\nexit 1");
    const events = await collect(claudeCodeEngine({ command }).start(realFolderRequest()));
    expect(events).toEqual([{ type: "error", message: "auth expired" }]);
  });

  it("reports a missing Claude Code", async () => {
    const events = await collect(claudeCodeEngine({ command: "/nonexistent/claude" }).start(realFolderRequest()));
    expect(events).toEqual([{ type: "error", message: "Claude Code is not installed." }]);
  });
});
