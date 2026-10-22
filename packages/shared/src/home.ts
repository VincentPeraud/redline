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

/** A project as the home shows it. */
export interface HomeProject {
  id: string;
  title: string;
  pageCount: number;
  /** Open threads, all pages. */
  openThreads: number;
  /** Threads of the project in waiting work items. */
  waitingThreads: number;
  /** ISO time of the latest version of any page; absent for a project without pages. */
  updatedAt?: string;
}

export interface HomeOverview {
  projectCount: number;
  projects: HomeProject[];
  agents: AgentOverview[];
  recentPages: RecentPage[];
  work: WorkOverview[];
  /** Threads in waiting work items, all projects. */
  waitingThreads: number;
}
