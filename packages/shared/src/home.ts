import type { AgentInfo, Page, QueueReason, RefusedAgent } from "./index.js";

/** `GET /api/home`: everything the home screen, the Agents screen and the sidebar show. */
export const HOME_PATH = "/api/home";

/** A project an agent covers: its own project (project agent) or the projects that allow the global agent (global agent). */
export interface CoveredProject {
  id: string;
  title: string;
  /** This agent runs the project's new work right now. */
  servedNow: boolean;
  /** The viewer cannot see this Privé project: it shows as "Projet privé", with no id. */
  private?: true;
}

export interface AgentOverview extends AgentInfo {
  /** Projects this agent covers: a project agent's linked project, or for the global agent the projects whose effective setting lets it take over. */
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
  reason?: QueueReason;
  threadCount: number;
  agentMachine?: string;
  /** The viewer cannot see the project: titles read "Projet privé" and the page is not named. */
  private?: true;
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
  /** The page holding that latest version, previewed on the project's card; absent for a project without pages. */
  lastPageId?: string;
}

export interface HomeOverview {
  projectCount: number;
  projects: HomeProject[];
  agents: AgentOverview[];
  refusedAgents: RefusedAgent[];
  recentPages: RecentPage[];
  work: WorkOverview[];
  /** Threads in waiting work items, all projects. */
  waitingThreads: number;
  /** Design systems (not archived) with changes not diffused. */
  designSystemsToDiffuse: number;
}
