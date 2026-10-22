# Claude Code engine adapter

Code: `packages/agent/src/claude-code-engine.ts`. Recorded fixtures: `packages/agent/test/fixtures/claude-stream/` (recorded with Claude Code 2.1.307, Haiku; paths anonymised, init event trimmed).

## Command line

One turn = one `claude` process; the message goes through stdin (no length limit, no leading-dash trouble).

```
claude -p (--session-id <uuid> | --resume <uuid>) --output-format stream-json --verbose --include-partial-messages
  --permission-mode dontAsk
  --allowedTools "Read,Glob,Grep,Edit(/.redline/<page>/**),Write(/.redline/<page>/**),mcp__redline"
  --disallowedTools "Bash,PowerShell,NotebookEdit"
  --setting-sources ""
  --mcp-config '{"mcpServers":{"redline":{"type":"http","url":"<per-run MCP url>"}}}' [<cwd>/.mcp.json]
  [--model <m>] [--effort <low|medium|high|xhigh|max>]
```

- `--verbose` is required for stream-json in `-p`; `--include-partial-messages` is required for text streaming and for the final output tokens of each call.
- `--resume` keeps the same session id. Resuming an unknown id exits 1 with a `result` event `subtype: "error_during_execution"` and `errors: ["No conversation found with session ID: ..."]`.
- Without `--model` / `--effort`, the machine's Claude Code configuration applies.

## Permissions

`dontAsk` denies everything not explicitly allowed (no prompt). Verified on a real run: a write to `.redline/p1/a.txt` and to `.redline/p1/sub/a.txt` succeeds; a write to `.redline/other/b.txt` or `outside.txt` is denied (`system` event `permission_denied`); Bash is absent from the session's tools. In a path pattern, a leading `/` means "relative to the session's cwd" (the agent's folder), so the rule is the page's working copy only. The MCP server is named `redline`, so its tools are `mcp__redline__<tool>`.

### Settings files

User, project (`.claude/settings.json`) and local settings files would otherwise apply, and an `allow` rule there (for example `Edit(src/**)`) widens what is writable. Verified (Claude Code 2.1.307, Haiku, temp project with `Edit(src/**)`/`Write(src/**)` allowed in `.claude/settings.json`, a `CLAUDE.md` marker and a stdio server in `.mcp.json`; the folder must be trusted, otherwise `-p` ignores the project's allow rules on its own):

| Option | `src/` write | CLAUDE.md | `.mcp.json` server | User-scope MCP servers (`~/.claude.json`) | claude.ai connectors / login |
| --- | --- | --- | --- | --- | --- |
| nothing (default) | allowed (gap) | loaded | available | available | available |
| `--setting-sources user` | denied | not loaded | not available | available | available |
| `--setting-sources project` | allowed (gap) | loaded | available | not available | available |
| `--setting-sources local` | denied | loaded | not available | not available | available |
| `--setting-sources ""` | denied | loaded | not available | not available | available |
| `--setting-sources "" --mcp-config <project>/.mcp.json` | denied | loaded | available | not available | available |

The adapter uses the last row: `--setting-sources ""` plus the project's `.mcp.json` passed explicitly to `--mcp-config` (only when the file exists; it comes after the Redline server config, both are kept). Cost: user-scope MCP servers and everything else from the user's settings files (default model, env, hooks, user-level permission rules) no longer apply to Redline sessions; the login keeps working. Not tested: whether the user's global `~/.claude/CLAUDE.md` is still loaded with an empty `--setting-sources`.

## Stream-json events used

| Event | Used for |
| --- | --- |
| `stream_event` / `message_start` | model of the call (`message.model`) |
| `stream_event` / `content_block_delta` with `text_delta` | `text` event |
| `stream_event` / `message_delta` | `usage` event (see below) |
| `assistant` with a `tool_use` block | `step` event (`name`, summary from `input.file_path`, `command`, `pattern`, or the MCP tool name) |
| `result` | `result` event, or `error` when `is_error` is true or `subtype` is not `success` |

Everything else (`system` init/status/hook/thinking_tokens/permission_denied, `rate_limit_event`, `user` tool results, thinking and `input_json_delta` deltas) is ignored. Events with a `parent_tool_use_id` (sub-agents) are ignored.

Failures seen: an unknown `--model` ends with `result` `is_error: true`, `subtype: "success"` (sic), `terminal_reason: "api_error"`, `api_error_status: 404` and the explanation in `result`. So errors are detected with `is_error`, not with `subtype`.

## Usage fields (context %)

Context % = tokens of the last model call / context window. Per model call, `message_delta.usage` (stream_event, with `--include-partial-messages`) has the final values:

- `input_tokens` (uncached input, tiny with caching)
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `output_tokens` (final; also `output_tokens_details.thinking_tokens`)

The adapter emits `inputTokens = input_tokens`, `cacheTokens = cache_creation_input_tokens + cache_read_input_tokens`, `outputTokens = output_tokens`, so context used = their sum. Do not read `assistant` events for this: their `message.usage.output_tokens` is a partial count (3 where the final is 239). The `result` event's `usage` is cumulative over all calls of the turn (do not use it for context %); its `usage.iterations` holds one entry, the last call, and `modelUsage.<model>.contextWindow` gives the window (1,000,000 for claude-haiku-5-5 in the recording).

## Auto-compaction in `-p` mode

Not observed: a real compaction needs a context far larger than a cheap test can reach. What is known: `claude --help` lists `--autocompact <auto|tokens>` ("Auto-compact window size (auto, or 100k-1M tokens)"), with `auto` as the implied default, and the flag is not restricted to interactive mode. Treat `-p` as auto-compacting by default; the 70 % warning and "Nouvelle session" (ticket 14) still protect quality before that point. To confirm, run a turn with `--autocompact 100k` on a session that goes past 100k tokens and look for a `system` event with subtype `compact_boundary` (the adapter ignores unknown system events, so a compaction would pass unnoticed today).
