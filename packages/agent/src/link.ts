import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_API_PREFIX, type Project } from "@redline/shared";
import { normalizeServerUrl, pickServer, type Login } from "./login.js";

export type LinkChoice = { existing: string } | { create: string };

export interface LinkOptions {
  folder: string;
  /** Every server set up on this machine; the agents' token of each guards `/agent-api`. */
  servers: Login[];
  /** Asked only when the folder has no usable link and several servers are set up. */
  chooseServer(servers: Login[]): Promise<Login>;
  /** Asked only when the folder is not linked to a project of its server. */
  choose(projects: Project[]): Promise<LinkChoice>;
}

interface FolderLink {
  /** Absent in links made before several servers were supported. */
  serverUrl?: string;
  projectId: string;
}

const LINK_FILE = "project.json";
const IGNORE_ENTRY = ".redline/";

export function readLink(folder: string): FolderLink | undefined {
  try {
    const link = JSON.parse(readFileSync(join(folder, ".redline", LINK_FILE), "utf8")) as Partial<FolderLink>;
    return link.projectId ? { projectId: link.projectId, serverUrl: link.serverUrl } : undefined;
  } catch {
    return undefined;
  }
}

export function readLinkedProjectId(folder: string): string | undefined {
  return readLink(folder)?.projectId;
}

/** The server the folder is linked to: its own, or for an old link the only (or first) one set up. */
export function linkedServer(folder: string, servers: Login[]): Login | undefined {
  const link = readLink(folder);
  if (!link) return undefined;
  const wanted = link.serverUrl && normalizeServerUrl(link.serverUrl);
  return wanted ? servers.find((server) => normalizeServerUrl(server.serverUrl) === wanted) : servers[0];
}

/** The server `redline mcp` talks to from `folder`: the folder's own, else the only one set up. */
export function serverForFolder(folder: string, servers: Login[]): Login {
  return linkedServer(folder, servers) ?? pickServer(servers);
}

function writeLink(folder: string, link: FolderLink): void {
  mkdirSync(join(folder, ".redline"), { recursive: true });
  writeFileSync(join(folder, ".redline", LINK_FILE), JSON.stringify(link, null, 2));
}

export function ensureGitignored(folder: string): void {
  const file = join(folder, ".gitignore");
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const already = content.split(/\r?\n/).some((line) => /^\/?\.redline\/?$/.test(line.trim()));
  if (already) return;
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${content}${separator}${IGNORE_ENTRY}\n`);
}

async function callProjects<T>(server: Login, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
  const res = await fetch(`${server.serverUrl}${AGENT_API_PREFIX}/projects`, {
    method: init.method,
    redirect: "error",
    headers: { authorization: `Bearer ${server.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
  return (await res.json()) as T;
}

/**
 * Links the folder to a project (picked or created) unless it already is, and keeps `.redline/` out of git.
 * An old link without a server is completed. Returns the project id and the server it lives on.
 */
export async function linkFolder({ folder, servers, chooseServer, choose }: LinkOptions): Promise<{ projectId: string; server: Login }> {
  let server = linkedServer(folder, servers);
  let projectId = readLinkedProjectId(folder);
  const projects = server ? await callProjects<Project[]>(server, { method: "GET" }) : undefined;
  if (!server || !projectId || !projects?.some((p) => p.id === projectId)) {
    server = servers.length === 1 ? servers[0] : await chooseServer(servers);
    const choice = await choose(await callProjects<Project[]>(server, { method: "GET" }));
    projectId = "existing" in choice ? choice.existing : (await callProjects<Project>(server, { method: "POST", body: { title: choice.create } })).id;
  }
  writeLink(folder, { serverUrl: server.serverUrl, projectId });
  ensureGitignored(folder);
  return { projectId, server };
}
