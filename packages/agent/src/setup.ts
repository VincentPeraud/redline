import { execFile } from "node:child_process";
import { saveLogin, validateServerUrl } from "./login.js";
import { ServerApi } from "./server-api.js";

interface ClaudeResult {
  ok: boolean;
  missing: boolean;
  stdout: string;
}

function claude(args: string[], env: NodeJS.ProcessEnv): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    execFile("claude", args, { env }, (error, stdout) => {
      resolve({ ok: !error, missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT", stdout });
    });
  });
}

/** Whether Claude Code already has the user-scope `redline` entry running `redline mcp`. */
function isRegistered(output: string): boolean {
  return /Scope:\s*User/i.test(output) && /Command:\s*redline\s*$/im.test(output) && /Args:\s*mcp\s*$/im.test(output);
}

/** Registers `redline mcp` in Claude Code at user scope; an identical entry is left alone, a different one replaced. */
async function registerMcp(env: NodeJS.ProcessEnv): Promise<void> {
  const existing = await claude(["mcp", "get", "redline"], env);
  if (existing.missing) {
    throw new Error("Claude Code is not installed. Install it (https://docs.claude.com/claude-code), then run `redline setup` again.");
  }
  if (existing.ok && isRegistered(existing.stdout)) return;
  if (existing.ok) await claude(["mcp", "remove", "--scope", "user", "redline"], env);
  const added = await claude(["mcp", "add", "--scope", "user", "redline", "--", "redline", "mcp"], env);
  if (!added.ok) throw new Error("`claude mcp add` failed. Run it yourself: claude mcp add --scope user redline -- redline mcp");
}

export interface SetupOptions {
  configDir: string;
  serverUrl: string;
  token: string;
  env?: NodeJS.ProcessEnv;
}

/** Checks the URL and the token, stores the server, and registers the Redline MCP in Claude Code. Safe to rerun. */
export async function setupServer({ configDir, serverUrl, token, env = process.env }: SetupOptions): Promise<void> {
  const url = validateServerUrl(serverUrl);
  const cleanToken = token.trim();
  if (!cleanToken) throw new Error("A token is required.");
  try {
    await new ServerApi(url, cleanToken).listProjects();
  } catch (error) {
    throw new Error(`Cannot use ${url} with this token: ${(error as Error).message}`);
  }
  saveLogin({ configDir, serverUrl: url, token: cleanToken });
  await registerMcp(env);
}
