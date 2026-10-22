import type { FastifyInstance } from "fastify";
import { HOME_PATH, type AgentOverview, type CoveredProject, type HomeOverview, type WorkOverview } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

const RECENT_PAGES = 5;

export function registerHomeRoutes(app: FastifyInstance, store: Store, pageLock: PageLock): void {
  app.get(HOME_PATH, async (): Promise<HomeOverview> => {
    const projects = store.listProjects();
    const titleOf = new Map(projects.map((p) => [p.id, p.title]));
    const { running, waiting } = pageLock.overview();

    const covered = (agentId: string, kind: string): CoveredProject[] =>
      projects
        .filter((p) => (kind === "global" ? !p.agent : p.agent?.id === agentId))
        .map((p) => ({ id: p.id, title: p.title, allowGlobalTakeover: p.allowGlobalTakeover }));

    const agents: AgentOverview[] = store.listAgents().map((agent) => {
      const coveredProjects = covered(agent.id, agent.kind);
      const ids = new Set(coveredProjects.map((p) => p.id));
      return {
        ...agent,
        projects: coveredProjects,
        running: running.filter((r) => r.agentId === agent.id).length,
        waitingThreads: waiting.filter((w) => ids.has(w.projectId)).reduce((sum, w) => sum + w.threadIds.length, 0),
      };
    });

    const machineOf = new Map(agents.map((a) => [a.id, a.machine]));
    const describe = (pageId: string) => {
      const page = store.getPage(pageId);
      return { pageTitle: page?.title ?? "", projectTitle: (page && titleOf.get(page.projectId)) ?? "" };
    };
    const work: WorkOverview[] = [
      ...running.map((r): WorkOverview => ({
        workId: r.workId,
        pageId: r.pageId,
        ...describe(r.pageId),
        state: "running",
        threadCount: r.threadIds.length,
        agentMachine: machineOf.get(r.agentId),
      })),
      ...waiting.map((w): WorkOverview => ({
        workId: w.workId,
        pageId: w.pageId,
        ...describe(w.pageId),
        state: "waiting",
        reason: w.reason,
        threadCount: w.threadIds.length,
      })),
    ];

    return {
      projectCount: projects.length,
      agents,
      recentPages: store.listRecentPages(RECENT_PAGES).map(({ page, updatedAt }) => ({
        page,
        projectTitle: titleOf.get(page.projectId) ?? "",
        updatedAt,
      })),
      work,
      waitingThreads: waiting.reduce((sum, w) => sum + w.threadIds.length, 0),
    };
  });
}
