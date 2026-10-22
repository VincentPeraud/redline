import type { AgentInfo, Page } from "./index.js";

/** `GET /api/home`: everything the home screen, the Agents screen and the sidebar show. */
export const HOME_PATH = "/api/home";

/** A project an agent serves: its own project (project agent) or the projects without a project agent (global agent). */
export interface CoveredProject {
  id: string;
  title: string;
  allowGlobalTakeover: boolean;
}

export interface AgentOverview extends AgentInfo {
  /** Projects this agent covers: a project agent's linked project, or for the global agent the projects with no project agent. */
  projects: CoveredProject[];
  /** Work items running on this agent now. */
  running: number;
  /** Threads waiting in the queue of the projects this agent covers. */
  waitingThreads: number;
}

export interface RecentPage {
  page: Page;
  projectTitle: string;
  updatedAt: string;
}

export interface WorkOverview {
  workId: string;
  pageId: string;
  pageTitle: string;
  projectTitle: string;
  /** "running": an agent works on it; "waiting": queued. */
  state: "running" | "waiting";
  reason?: "page-busy" | "agent-offline";
  threadCount: number;
  agentMachine?: string;
}

export interface HomeOverview {
  projectCount: number;
  agents: AgentOverview[];
  recentPages: RecentPage[];
  work: WorkOverview[];
  /** Threads in waiting work items, all projects. */
  waitingThreads: number;
}

/** `GET /api/projects-activity`: what a project card on the Projects screen shows besides the project itself. */
export const PROJECTS_ACTIVITY_PATH = "/api/projects-activity";

export interface ProjectActivity {
  projectId: string;
  pageCount: number;
  /** Threads sent and not resolved yet, queued ones included. */
  openThreads: number;
  /** Threads in work items that wait in the queue. */
  waitingThreads: number;
  /** Latest page version, else the project's creation. */
  updatedAt: string;
}
