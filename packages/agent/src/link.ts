import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_API_PREFIX, type Project } from "@redline/shared";

export type LinkChoice = { existing: string } | { create: string };

export interface LinkOptions {
  folder: string;
  serverUrl: string;
  /** The agents' token: projects are listed and created through the token-guarded `/agent-api`. */
  token: string;
  /** Asked only when the folder is not linked to a project of this server. */
  choose(projects: Project[]): Promise<LinkChoice>;
}

const LINK_FILE = "project.json";
const IGNORE_ENTRY = ".redline/";

function readLinkedProjectId(folder: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(folder, ".redline", LINK_FILE), "utf8")) as { projectId?: string }).projectId;
  } catch {
    return undefined;
  }
}

export function ensureGitignored(folder: string): void {
  const file = join(folder, ".gitignore");
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const already = content.split(/\r?\n/).some((line) => /^\/?\.redline\/?$/.test(line.trim()));
  if (already) return;
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${content}${separator}${IGNORE_ENTRY}\n`);
}

/** Links the folder to a project (picked or created) unless it already is, and keeps `.redline/` out of git. Returns the project id. */
export async function linkFolder({ folder, serverUrl, token, choose }: LinkOptions): Promise<string> {
  const call = async <T>(init: { method: "GET" | "POST"; body?: unknown }): Promise<T> => {
    const res = await fetch(`${serverUrl}${AGENT_API_PREFIX}/projects`, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
    return (await res.json()) as T;
  };
  const projects = await call<Project[]>({ method: "GET" });
  let projectId = readLinkedProjectId(folder);
  if (!projectId || !projects.some((p) => p.id === projectId)) {
    const choice = await choose(projects);
    if ("existing" in choice) projectId = choice.existing;
    else {
      projectId = (await call<Project>({ method: "POST", body: { title: choice.create } })).id;
    }
    mkdirSync(join(folder, ".redline"), { recursive: true });
    writeFileSync(join(folder, ".redline", LINK_FILE), JSON.stringify({ projectId }, null, 2));
  }
  ensureGitignored(folder);
  return projectId;
}
