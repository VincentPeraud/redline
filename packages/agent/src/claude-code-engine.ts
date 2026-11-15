import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { EngineEvent } from "@redline/shared";
import type { Engine, EngineRunRequest } from "./engine.js";

const MCP_SERVER_NAME = "redline";

/** Files a session must never read: env files, the folder link, Redline's login and SSH keys. */
const SECRET_FILES = ["**/.env*", "**/.redline/project.json", "~/.config/redline/**", "~/.ssh/**"];

/**
 * Permission rules: read only inside the agent's folder (a leading "/" is relative to the session's cwd; anything
 * else is refused by `dontAsk`), minus the files that hold secrets; write only in the page's working copy;
 * call Redline's MCP tools. Denying `~/**` would also deny a folder that lives under the home directory, so the
 * home-level secrets are denied by name.
 */
export function claudePermissionRules(request: Pick<EngineRunRequest, "cwd" | "workingCopyDir">): {
  allowed: string[];
  denied: string[];
} {
  const relative = path.relative(request.cwd, request.workingCopyDir).split(path.sep).join("/");
  if (relative === "" || relative.startsWith("..")) {
    throw new Error("The working copy must be inside the agent's folder.");
  }
  // A leading "/" in a permission path pattern means "relative to the project root" (the session's cwd).
  const writable = `/${relative}/**`;
  return {
    allowed: ["Read(/**)", "Glob(/**)", "Grep(/**)", `Edit(${writable})`, `Write(${writable})`, `mcp__${MCP_SERVER_NAME}`],
    denied: ["Bash", "PowerShell", "NotebookEdit", ...SECRET_FILES.map((pattern) => `Read(${pattern})`)],
  };
}

/** Arguments of `claude` for one turn. The message itself goes through stdin. */
export function buildClaudeArgs(request: EngineRunRequest, mode: "start" | "resume"): string[] {
  const { allowed, denied } = claudePermissionRules(request);
  const args = [
    "-p",
    mode === "start" ? "--session-id" : "--resume",
    request.sessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    allowed.join(","),
    "--disallowedTools",
    denied.join(","),
    // No settings file (user, project, local): an `allow` rule there would widen what the session can write.
    "--setting-sources",
    "",
    // Only the Redline server: the project's own MCP servers could act outside .redline/ (spec story 11).
    "--mcp-config",
    JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: request.mcpUrl } } }),
  ];
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  return args;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

function toolSummary(tool: string, input: Json, cwd: string): string {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const filePath = text("file_path");
  if (filePath) return path.isAbsolute(filePath) ? path.relative(cwd, filePath) || filePath : filePath;
  if (tool === "Bash") return text("command");
  if (tool === "Glob" || tool === "Grep") return text("pattern");
  if (tool.startsWith("mcp__")) return tool.split("__").slice(2).join("__");
  return "";
}

/**
 * Turns the stream-json lines of one `claude -p` turn into engine events.
 * Text comes from the partial-message deltas, steps from complete tool_use blocks, usage from the
 * `message_delta` of each model call (the only place where its final output tokens are known).
 */
export function createStreamParser(cwd: string) {
  let model = "";
  let finished = false;
  const seenToolUses = new Set<string>();

  function push(line: string): EngineEvent[] {
    if (finished || !line.trim()) return [];
    let message: Json;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return [];
    }
    const mainThread = message.parent_tool_use_id == null;

    if (message.type === "stream_event" && mainThread) {
      const event = asRecord(message.event);
      if (event.type === "message_start") {
        model = String(asRecord(event.message).model ?? model);
      } else if (event.type === "content_block_delta") {
        const delta = asRecord(event.delta);
        if (delta.type === "text_delta" && typeof delta.text === "string") return [{ type: "text", text: delta.text }];
      } else if (event.type === "message_delta") {
        const usage = asRecord(event.usage);
        return [
          {
            type: "usage",
            model,
            inputTokens: Number(usage.input_tokens ?? 0),
            cacheTokens: Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
          },
        ];
      }
      return [];
    }

    if (message.type === "assistant" && mainThread) {
      const content = asRecord(message.message).content;
      const steps: EngineEvent[] = [];
      for (const block of Array.isArray(content) ? content : []) {
        const item = asRecord(block);
        if (item.type !== "tool_use" || typeof item.id !== "string" || seenToolUses.has(item.id)) continue;
        seenToolUses.add(item.id);
        const tool = String(item.name);
        steps.push({ type: "step", tool, summary: toolSummary(tool, asRecord(item.input), cwd) });
      }
      return steps;
    }

    if (message.type === "result") {
      finished = true;
      const errors = Array.isArray(message.errors) ? message.errors.map(String).join("\n") : "";
      const text = typeof message.result === "string" ? message.result : "";
      if (message.is_error === true || message.subtype !== "success") {
        return [{ type: "error", message: text || errors || `Claude Code failed (${String(message.subtype)}).` }];
      }
      const windows = Object.values(asRecord(message.modelUsage)).map((usage) => Number(asRecord(usage).contextWindow));
      const contextWindow = Number(asRecord(asRecord(message.modelUsage)[model]).contextWindow) || windows.find((w) => w > 0);
      return [{ type: "result", summary: text, ...(contextWindow ? { contextWindow } : {}) }];
    }
    return [];
  }

  /** Call when the stream ended: reports a stream that never produced a result. */
  function end(detail: string): EngineEvent[] {
    if (finished) return [];
    finished = true;
    return [{ type: "error", message: detail || "Claude Code ended without a result." }];
  }

  return { push, end };
}

export interface ClaudeCodeEngineOptions {
  /** Executable to run; defaults to `claude`. */
  command?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ends Claude Code and everything it started (its tools, MCP servers): it runs as the leader of its own process group, which is
 * signalled as a whole. Windows has no process groups: the process alone is killed.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

export function claudeCodeEngine(options: ClaudeCodeEngineOptions = {}): Engine {
  async function* run(request: EngineRunRequest, mode: "start" | "resume"): AsyncGenerator<EngineEvent> {
    if (request.signal?.aborted) return;
    const child = spawn(options.command ?? "claude", buildClaudeArgs(request, mode), {
      cwd: request.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const cancel = () => killTree(child);
    request.signal?.addEventListener("abort", cancel, { once: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const spawnFailure = new Promise<Error>((resolve) => child.once("error", resolve));
    // stdout can end before the last stderr chunk is read (Linux): "close" comes once every stream is drained
    const streamsClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdin.on("error", () => {});
    child.stdin.end(request.message);

    const parser = createStreamParser(request.cwd);
    try {
      const lines = createInterface({ input: child.stdout });
      const reading = (async function* () {
        for await (const line of lines) yield line;
      })();
      const failed = spawnFailure.then((error) => ({ error }));
      for (;;) {
        const next = await Promise.race([reading.next(), failed]);
        if ("error" in next) {
          const reason = (next.error as NodeJS.ErrnoException).code === "ENOENT" ? "Claude Code is not installed." : next.error.message;
          yield { type: "error", message: reason };
          return;
        }
        if (next.done) break;
        yield* parser.push(next.value);
      }
      // Bounded, for a process that closes stdout but keeps running
      await Promise.race([streamsClosed, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      yield* parser.end(stderr.trim());
    } finally {
      request.signal?.removeEventListener("abort", cancel);
      killTree(child);
    }
  }

  return {
    start: (request) => run(request, "start"),
    resume: (request) => run(request, "resume"),
  };
}
