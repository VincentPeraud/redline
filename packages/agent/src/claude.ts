import { execFile } from "node:child_process";

type RunResult = { stdout: string; missing: boolean; ok: boolean };

function run(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile("claude", args, { env }, (error, stdout) => {
      const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
      resolve({ stdout, missing, ok: !error });
    });
  });
}

function accountOf(authStatus: string): string | undefined {
  try {
    const email: unknown = JSON.parse(authStatus).email;
    return typeof email === "string" && email ? email : undefined;
  } catch {
    return undefined;
  }
}

/** Throws a user-facing error unless Claude Code is installed and logged in; returns the logged-in account's email when known. */
export async function checkClaude(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const version = await run(["--version"], env);
  if (version.missing) {
    throw new Error("Claude Code is not installed. Install it (https://docs.claude.com/claude-code), then retry.");
  }
  const auth = await run(["auth", "status"], env);
  if (!auth.ok || !/"loggedIn":\s*true/.test(auth.stdout)) {
    throw new Error("Claude Code is not logged in. Run `claude` once to log in, then retry.");
  }
  return accountOf(auth.stdout);
}
