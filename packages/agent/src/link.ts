import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AGENT_API_PREFIX, type Project } from "@redline/shared";
import { normalizeServerUrl, pickServer, type Login } from "./login.js";

export type LinkChoice = { existing: string } | { create: string };
/** What to do with a folder that is already linked: add a project, or stop serving one (never the last). */
export type MoreChoice = LinkChoice | { remove: string };

export interface LinkOptions {
  folder: string;
  /** Every server set up on this machine; the agents' token of each guards `/agent-api`. */
  servers: Login[];
  /** Asked only when the folder has no usable link and several servers are set up. */
  chooseServer(servers: Login[]): Promise<Login>;
  /** Asked only when the folder is not linked to a project of its server. */
  choose(projects: Project[]): Promise<LinkChoice>;
  /**
   * Asked when the folder was already linked: another project for it to serve too, one to stop serving, or nothing to go on.
   * `others` leaves out the projects another online agent serves. Asked again after each change. Absent outside a terminal.
   */
  chooseMore?(linked: Project[], others: Project[]): Promise<MoreChoice | undefined>;
}

interface FolderLink {
  /** Absent in links made before several servers were supported. */
  serverUrl?: string;
  projectIds: string[];
}

const LINK_FILE = "project.json";
const IGNORE_ENTRY = ".redline/";

export function readLink(folder: string): FolderLink | undefined {
  try {
    // `projectId`: a link made before a folder could serve several projects.
    const link = JSON.parse(readFileSync(join(folder, ".redline", LINK_FILE), "utf8")) as Partial<FolderLink> & { projectId?: string };
    const projectIds = Array.isArray(link.projectIds) ? link.projectIds.filter((id) => typeof id === "string") : link.projectId ? [link.projectId] : [];
    return projectIds.length > 0 ? { projectIds, serverUrl: link.serverUrl } : undefined;
  } catch {
    return undefined;
  }
}

export function readLinkedProjectIds(folder: string): string[] {
  return [...new Set(readLink(folder)?.projectIds ?? [])];
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

async function callProjects<T>(server: Login, init: { method: "GET" | "POST"; body?: unknown }, query = ""): Promise<T> {
  const res = await fetch(`${server.serverUrl}${AGENT_API_PREFIX}/projects${query}`, {
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
 * A folder already linked keeps its projects (those gone from the server are dropped) and may be given more.
 * An old link without a server is completed. Returns the projects the folder serves and the server they live on.
 */
export async function linkFolder({ folder, servers, chooseServer, choose, chooseMore }: LinkOptions): Promise<{ projectIds: string[]; projects: Project[]; server: Login }> {
  let server = linkedServer(folder, servers);
  const all = server ? await callProjects<Project[]>(server, { method: "GET" }, "?all=1") : [];
  let projects = all.filter((p) => !p.archivedAt);
  const linkedAll = readLinkedProjectIds(folder).flatMap((id) => all.filter((p) => p.id === id));
  // Archived projects stay in the link (unarchiving one brings the folder back to it) but are not served.
  const archived = linkedAll.filter((p) => p.archivedAt);
  let linked = linkedAll.filter((p) => !p.archivedAt);
  if (server && linked.length === 0 && archived.length > 0) {
    const titles = archived.map((p) => `"${p.title}"`).join(", ");
    throw new Error(`This folder's ${archived.length > 1 ? `projects ${titles} are` : `project ${titles} is`} archived. Unarchive it in Redline, or remove .redline/link.json to link the folder to another project.`);
  }
  const pick = async (choice: LinkChoice): Promise<Project> =>
    "existing" in choice ? projects.find((p) => p.id === choice.existing)! : callProjects<Project>(server!, { method: "POST", body: { title: choice.create } });
  if (!server || linked.length === 0) {
    server = servers.length === 1 ? servers[0] : await chooseServer(servers);
    projects = await callProjects<Project[]>(server, { method: "GET" });
    linked = [await pick(await choose(projects))];
  } else if (chooseMore) {
    const servedElsewhere = (p: Project) => p.agent?.status === "online" && !(p.agent.machine === hostname() && p.agent.folder === folder);
    for (;;) {
      const others = projects.filter((p) => !linked.some((l) => l.id === p.id) && !servedElsewhere(p));
      const choice = await chooseMore(linked, others);
      if (!choice) break;
      if (!("remove" in choice)) linked = [...linked, await pick(choice)];
      else if (linked.length > 1) linked = linked.filter((p) => p.id !== choice.remove);
    }
  }
  const projectIds = linked.map((p) => p.id);
  writeLink(folder, { serverUrl: server.serverUrl, projectIds: [...projectIds, ...archived.map((p) => p.id)] });
  ensureGitignored(folder);
  return { projectIds, projects: linked, server };
}
