import type { FastifyInstance } from "fastify";
import { HOME_PATH, type AgentOverview, type CoveredProject, type HomeOverview, type HomeProject, type WorkOverview } from "@redline/shared";
import { chooseAgent } from "./agent-selection.js";
import { diffusionReview, reviewLineCount } from "./diffusion-review.js";
import type { Access } from "./access.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

const RECENT_PAGES = 5;
const PRIVATE_PROJECT = "Projet privé";

export function registerHomeRoutes(app: FastifyInstance, store: Store, pageLock: PageLock, access: Access): void {
  app.get(HOME_PATH, async (req): Promise<HomeOverview> => {
    const seen = (projectId: string) => access.may(req.viewer, "read", { projectId });
    const projects = store.listProjects().filter((p) => seen(p.id));
    // Archived projects too: their waiting items stay listed until they are unarchived.
    const titleOf = new Map(store.listProjects("all").filter((p) => seen(p.id)).map((p) => [p.id, p.title]));
    const overview = pageLock.overview();
    // Work on a project the viewer does not see stays out of the thread counts and shows as "Projet privé" in the work list.
    const running = overview.running;
    const waitingAll = overview.waiting;
    const waiting = waitingAll.filter((w) => seen(w.projectId));
    const hidden = (projectId: string) => !seen(projectId);

    const covered = (agentId: string, kind: string): CoveredProject[] =>
      store
        .listProjects()
        .filter((p) => (kind === "global" ? p.globalTakeover : p.agent?.id === agentId))
        .map((p): CoveredProject => {
          const servedNow = chooseAgent(store, p.id)?.agentId === agentId;
          return seen(p.id) ? { id: p.id, title: p.title, servedNow } : { id: "", title: PRIVATE_PROJECT, servedNow, private: true };
        });

    const agents: AgentOverview[] = store.listAgents().map((agent) => {
      const coveredProjects = covered(agent.id, agent.kind);
      const ids = new Set(coveredProjects.filter((p) => !p.private).map((p) => p.id));
      return {
        ...agent,
        projects: coveredProjects,
        running: running.filter((r) => r.agentId === agent.id).length,
        waitingThreads: waiting.filter((w) => ids.has(w.projectId)).reduce((sum, w) => sum + w.threadIds.length, 0),
      };
    });

    const machineOf = new Map(agents.map((a) => [a.id, a.machine]));
    const describe = (pageId: string): Pick<WorkOverview, "pageTitle" | "projectTitle" | "private"> => {
      const page = store.getPage(pageId);
      if (page && hidden(page.projectId)) return { pageTitle: "", projectTitle: PRIVATE_PROJECT, private: true };
      return { pageTitle: page?.title ?? "", projectTitle: (page && titleOf.get(page.projectId)) ?? "" };
    };
    const work: WorkOverview[] = [
      ...running.map((r): WorkOverview => ({
        workId: r.workId,
        ...describe(r.pageId),
        pageId: hidden(store.getPage(r.pageId)?.projectId ?? "") ? "" : r.pageId,
        state: "running",
        threadCount: r.threadIds.length,
        agentMachine: machineOf.get(r.agentId),
      })),
      ...waitingAll.map((w): WorkOverview => ({
        workId: w.workId,
        ...describe(w.pageId),
        pageId: hidden(w.projectId) ? "" : w.pageId,
        state: "waiting",
        reason: w.reason,
        threadCount: w.threadIds.length,
      })),
    ];

    const lastUpdate = new Map<string, { updatedAt: string; lastPageId: string }>();
    for (const { page, updatedAt } of store.listRecentPages(Number.MAX_SAFE_INTEGER).filter(({ page }) => seen(page.projectId))) {
      if (!lastUpdate.has(page.projectId)) lastUpdate.set(page.projectId, { updatedAt, lastPageId: page.id });
    }
    const homeProjects: HomeProject[] = projects.map((p) => {
      const pages = store.listPages(p.id, "active");
      return {
        id: p.id,
        title: p.title,
        pageCount: pages.length,
        openThreads: pages.reduce((sum, page) => sum + store.listThreads(page.id).filter((t) => t.status === "open").length, 0),
        waitingThreads: waiting.filter((w) => w.projectId === p.id).reduce((sum, w) => sum + w.threadIds.length, 0),
        ...lastUpdate.get(p.id),
      };
    });

    return {
      projectCount: projects.length,
      projects: homeProjects,
      agents,
      refusedAgents: store.listRefusedAgents(),
      recentPages: store.listRecentPages(Number.MAX_SAFE_INTEGER).filter(({ page }) => seen(page.projectId)).slice(0, RECENT_PAGES).map(({ page, updatedAt }) => ({
        page,
        projectTitle: titleOf.get(page.projectId) ?? "",
        updatedAt,
      })),
      work,
      waitingThreads: waiting.reduce((sum, w) => sum + w.threadIds.length, 0),
      designSystemsToDiffuse: store.listChoosableDesignSystems().filter((ds) => reviewLineCount(diffusionReview(store, ds.id)) > 0).length,
    };
  });
}
