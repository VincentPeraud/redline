import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** What a worker needs of its launching terminal's environment to run Claude Code as that terminal would. */
const CLAUDE_VARIABLES = /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_|VERTEX_)/;

/** The Claude-relevant variables of an environment: `PATH` and those of Claude Code and its cloud providers. */
export function claudeEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((pair): pair is [string, string] => typeof pair[1] === "string" && (pair[0] === "PATH" || CLAUDE_VARIABLES.test(pair[0]))));
}

/** The host's own variables a worker keeps: what any process needs, nothing the first terminal that started the host happened to have. */
const BASE_VARIABLES = ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL", "TZ"];

/**
 * The environment of a worker: the minimal base of the host, then what the client launching it sent, then the Claude config directory.
 * The default directory (`~/.claude`) is left implicit unless the client set it: Claude Code keys its keychain login on whether
 * `CLAUDE_CONFIG_DIR` is set, so forcing it would make the worker read a separate login that the terminal never refreshes.
 */
export function workerEnvironment({ host, client, extra, claudeConfigDir }: { host: NodeJS.ProcessEnv; client: Record<string, string> | undefined; extra?: NodeJS.ProcessEnv; claudeConfigDir: string }): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(host).filter(([name]) => BASE_VARIABLES.includes(name) || name.startsWith("LC_")));
  const fromClient = claudeEnvironment(client ?? {});
  const isDefault = resolve(claudeConfigDir) === join(host.HOME ?? homedir(), ".claude");
  const env: NodeJS.ProcessEnv = { ...base, PATH: host.PATH, ...extra, ...fromClient, CLAUDE_CONFIG_DIR: claudeConfigDir };
  if (isDefault && fromClient.CLAUDE_CONFIG_DIR === undefined) delete env.CLAUDE_CONFIG_DIR;
  return env;
}
