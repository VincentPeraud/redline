import type { Effort, EngineEvent } from "@redline/shared";

export interface EngineRunRequest {
  /** Engine session id: created by `start`, looked up by `resume`. */
  sessionId: string;
  message: string;
  /** The agent's code folder: the session runs here (CLAUDE.md, code, MCP servers). */
  cwd: string;
  /** Absolute path of the page's working copy, inside `cwd/.redline/`. The session may write only there. */
  workingCopyDir: string;
  /** URL of the local MCP server holding Redline's tools for this run. */
  mcpUrl: string;
  model?: string;
  effort?: Effort;
  /** Aborted when the agent stops: the engine ends the session at once, killing whatever it started. */
  signal?: AbortSignal;
}

/**
 * What the agent needs from a coding engine. Each call runs one turn to completion and ends its
 * stream with a `result` or an `error` event. Adapters: Claude Code (`claude-code-engine.ts`), scripted fake (tests).
 */
export interface Engine {
  start(request: EngineRunRequest): AsyncIterable<EngineEvent>;
  resume(request: EngineRunRequest): AsyncIterable<EngineEvent>;
}
