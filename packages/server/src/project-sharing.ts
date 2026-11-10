import type { FastifyInstance } from "fastify";
import { isAccessLevel, levelRank, type AccessLevel, type MemberChangeResponse, type ProjectSharing, type SetMemberLevelRequest } from "@redline/shared";
import type { Access, Viewer } from "./access.js";
import { personOf } from "./accounts.js";
import { linkViews } from "./link-routes.js";
import { isWorking, type StoredLink } from "./link-store.js";
import type { Store } from "./store.js";

/** The working links among `links` that `personIds` made, above `aboveLevel` when given: they keep working, and the dialogs offer to disable them. */
function workingLinksMadeBy(links: StoredLink[], personIds: string[], aboveLevel?: AccessLevel): StoredLink[] {
  return links.filter((link) => isWorking(link) && link.createdBy !== undefined && personIds.includes(link.createdBy.id) && (aboveLevel === undefined || levelRank(link.level) > levelRank(aboveLevel)));
}

/** Who sees a project and at which level: the sharing dialog's data and the member levels. */
export function registerProjectSharingRoutes(app: FastifyInstance, store: Store, access: Access): void {
  const views = linkViews(store, access);

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/sharing", async (req, reply): Promise<ProjectSharing | undefined> => {
    const project = store.getProject(req.params.projectId);
    if (!project) return void reply.code(404).send({ error: "project not found" });
    const accounts = store.accounts.activeAccounts();
    const isOwnerOrAdmin = (a: { id: string; role: string }) => a.role === "admin" || a.id === project.createdBy?.id;
    const canChange = access.manages(req.viewer, project.id);
    const wouldLoseAccess = project.visibility === "private" || !canChange ? [] : accounts.filter((a) => !isOwnerOrAdmin(a)).map(personOf);
    const projectLinks = canChange ? store.links.ofProject(project.id) : [];
    const linksOf = (personIds: string[], aboveLevel?: AccessLevel) => workingLinksMadeBy(projectLinks, personIds, aboveLevel).map((link) => views(req.viewer, link));
    const levels = store.memberLevels(project.id);
    const members = levels.flatMap(({ personId, level }) => {
      const account = accounts.find((a) => a.id === personId);
      return account ? [{ person: personOf(account), level, aboveLinks: linksOf([account.id], level) }] : [];
    });
    const candidates = canChange ? accounts.filter((a) => !isOwnerOrAdmin(a) && !levels.some((l) => l.personId === a.id)).map(personOf) : [];
    return {
      visibility: project.visibility,
      viewerLevel: access.levelOf(req.viewer, { projectId: project.id }) ?? "read",
      accountCount: accounts.length,
      ...(project.createdBy ? { createdBy: project.createdBy } : {}),
      canChange,
      members,
      candidates,
      wouldLoseAccess,
      lostAccessLinks: linksOf(wouldLoseAccess.map((p) => p.id)),
    };
  });

  /** The working links a member made on the project that their level no longer allows. */
  const linksAbove = (viewer: Viewer, projectId: string, personId: string, level: AccessLevel | undefined): MemberChangeResponse => ({
    links: workingLinksMadeBy(store.links.ofProject(projectId), [personId], level).map((link) => views(viewer, link)),
  });

  // Équipe: a level below Écriture lowers the member, Écriture lifts the exception. Privé: the level is the member's entry.
  app.put<{ Params: { projectId: string; personId: string }; Body: SetMemberLevelRequest }>("/api/projects/:projectId/members/:personId", async (req, reply) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const account = store.accounts.activeAccounts().find((a) => a.id === req.params.personId);
    if (!account) return reply.code(404).send({ error: "account not found" });
    const level = req.body?.level;
    if (!isAccessLevel(level)) return reply.code(400).send({ error: "level must be read, comment or write" });
    if (account.role === "admin" || account.id === project.createdBy?.id) return reply.code(400).send({ error: "The creator and the admins are always at Écriture." });
    if (project.visibility === "team" && level === "write") store.removeMemberLevel(project.id, account.id);
    else store.setMemberLevel(project.id, account.id, level);
    return linksAbove(req.viewer, project.id, account.id, level);
  });

  app.delete<{ Params: { projectId: string; personId: string } }>("/api/projects/:projectId/members/:personId", async (req, reply) => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    store.removeMemberLevel(req.params.projectId, req.params.personId);
    const project = store.getProject(req.params.projectId)!;
    // Back to the default: Écriture on an Équipe project (nothing to warn about), no access on a Privé one.
    return linksAbove(req.viewer, project.id, req.params.personId, project.visibility === "team" ? "write" : undefined);
  });
}
