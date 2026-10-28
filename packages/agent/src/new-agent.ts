import type { Effort } from "@redline/shared";
import { claudeConfigDirOf } from "./claude.js";
import type { HostClient } from "./host-client.js";
import type { HostAgent } from "./host-protocol.js";
import { lastLaunchChoice, rememberChoice } from "./launch-choice.js";
import { linkFolder, linkedServer, listProjects, readLinkedProjectIds, type LinkChoice } from "./link.js";
import { findLogin, requireLogins, type Login } from "./login.js";

export interface ProjectOption {
  id: string;
  title: string;
}

/** What the `n` dialog has to ask for the screen's folder. */
export interface NewAgentQuestions {
  /** Set when the server is known: the folder's own, or the only one set up. */
  serverUrl?: string;
  /** The servers to pick from, when several are set up and the folder is not linked. */
  servers: string[];
  /** The projects of the folder's server it could be linked to; absent while the server is still to pick. */
  projects?: ProjectOption[];
  /** The titles of the projects of a folder that is already linked: the project question is skipped. */
  linkedTitles?: string[];
  /** The folder's last choice. */
  model: string;
  effort?: Effort;
}

export interface NewAgentAnswers {
  serverUrl?: string;
  /** Absent for a folder that is already linked. */
  project?: LinkChoice;
  model: string;
  effort?: Effort;
}

/** What the agents screen needs to start an agent for its folder: tests give a fake, the CLI the real one. */
export interface NewAgentFlow {
  inspect(): Promise<NewAgentQuestions>;
  projectsOf(serverUrl: string): Promise<ProjectOption[]>;
  /** Links the folder if needed and has the host launch its agent; resolves with the agent. */
  start(answers: NewAgentAnswers): Promise<HostAgent>;
}

export interface NewAgentFlowOptions {
  folder: string;
  configDir: string;
  claudeSettingsFile: string;
  host: Pick<HostClient, "launch">;
  /** Reads the Claude account of this environment (throws when Claude Code is missing or logged out). */
  checkClaude(): Promise<string | undefined>;
}

const serverOf = (servers: Login[], url: string): Login => {
  const found = findLogin(servers, url);
  if (!found) throw new Error(`${url} is not a server set up on this machine.`);
  return found;
};

export function createNewAgentFlow({ folder, configDir, claudeSettingsFile, host, checkClaude }: NewAgentFlowOptions): NewAgentFlow {
  const servers = () => requireLogins(configDir);
  const choice = () => lastLaunchChoice({ folder, configDir, claudeSettingsFile });
  const open = (all: Login[]) => ({ servers: all.map((server) => server.serverUrl), ...choice() });
  return {
    async inspect() {
      const all = servers();
      const linked = linkedServer(folder, all);
      const ids = readLinkedProjectIds(folder);
      if (linked && ids.length > 0) {
        const projects = await listProjects(linked, true);
        const linkedTitles = ids.flatMap((id) => projects.filter((p) => p.id === id && !p.archivedAt).map((p) => p.title));
        if (linkedTitles.length > 0) return { ...open([]), serverUrl: linked.serverUrl, linkedTitles };
      }
      if (all.length === 1) return { ...open(all), serverUrl: all[0].serverUrl, projects: await listProjects(all[0]) };
      return open(all);
    },
    projectsOf: async (serverUrl) => listProjects(serverOf(servers(), serverUrl)),
    async start({ serverUrl, project, model, effort }) {
      const account = await checkClaude();
      const { projectIds, projects, server } = await linkFolder({
        folder,
        servers: servers(),
        chooseServer: async (all) => serverOf(all, serverUrl ?? all[0].serverUrl),
        choose: async () => {
          if (!project) throw new Error("This folder's project is gone from the server: pick one to link it again.");
          return project;
        },
      });
      rememberChoice({ folder, configDir, choice: { model, effort } });
      const { agent } = await host.launch({ folder, kind: "project", serverUrl: server.serverUrl, projectIds, projectNames: projects.map((p) => p.title), model, effort, claudeConfigDir: claudeConfigDirOf(), account });
      return agent;
    },
  };
}
