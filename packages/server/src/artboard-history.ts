import type { FastifyInstance } from "fastify";
import {
  MANIFEST_PATH,
  manifestWithoutArtboard,
  defaultManifest,
  isSafePath,
  parseManifest,
  type ArtboardVersion,
  type DeletedArtboard,
  type Manifest,
  type ManifestArtboard,
  type RestoreArtboardRequest,
  type RestoreArtboardResponse,
} from "@redline/shared";
import { requiredString } from "./validation.js";
import { personRef } from "./identity.js";
import type { Store, VersionRecord } from "./store.js";

const CREATED_TITLE = "Artboard créé";
const PUT_BACK_MESSAGE = "Remis depuis les artboards supprimés";
const PUT_BACK_UNDONE_MESSAGE = "Remise annulée";

/** Manifest of a version; a manifest that does not parse (it cannot be stored today) counts as none. */
function manifestOf(store: Store, record: VersionRecord): Manifest {
  const hash = record.files[MANIFEST_PATH];
  if (hash !== undefined) {
    try {
      return parseManifest(store.blobText(hash));
    } catch {
      // Falls through to the default layout.
    }
  }
  return defaultManifest(Object.keys(record.files));
}

/** The artboards a version shows: manifest entries whose file exists (every HTML file when there is no manifest). */
function artboardsOf(store: Store, record: VersionRecord): Map<string, ManifestArtboard> {
  return new Map(manifestOf(store, record).artboards.filter((a) => record.files[a.file] !== undefined).map((a) => [a.file, a]));
}

/** Versions of `records` (oldest first) in which the content of `file` changed. Tweak versions never are part of the history. */
function contentChanges(records: VersionRecord[], file: string): VersionRecord[] {
  const changes: VersionRecord[] = [];
  let previous: string | undefined;
  for (const record of records) {
    if (record.origin === "tweak") continue;
    const hash = record.files[file];
    if (hash !== undefined && hash !== previous) changes.push(record);
    previous = hash;
  }
  return changes;
}

function formatDate(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

function validTimeZone(timeZone: unknown): boolean {
  if (timeZone === undefined) return true;
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: timeZone as string });
    return typeof timeZone === "string";
  } catch {
    return false;
  }
}

/** Per-artboard history, deleted artboards and artboard restore: views and edits derived from the page versions. */
export function registerArtboardHistoryRoutes(app: FastifyInstance, store: Store): void {
  app.get<{ Params: { pageId: string }; Querystring: { file?: string } }>("/api/pages/:pageId/artboard-versions", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    const file = req.query.file;
    if (typeof file !== "string" || !isSafePath(file)) return reply.code(400).send({ error: "file is required" });
    const records = store.listVersionRecords(req.params.pageId);
    const headHash = records[records.length - 1]?.files[file];
    const changes = contentChanges(records, file);
    const newest = changes[changes.length - 1];
    const ownPage = store.isDesignSystemPage(req.params.pageId);
    const diffusionOf = (record: VersionRecord): ArtboardVersion["diffusion"] => {
      if (ownPage) return undefined;
      const hash = record.files[MANIFEST_PATH];
      const designSystemId = store.sharedDesignSystemIdForManifest(req.params.pageId, hash === undefined ? undefined : store.blobText(hash));
      const designSystem = designSystemId === undefined ? undefined : store.getDesignSystem(designSystemId);
      return designSystem && { designSystemTitle: designSystem.title, number: record.diffusion };
    };
    return changes
      .map((record): ArtboardVersion => {
        const diffusion = diffusionOf(record);
        return {
          versionId: record.id,
          title: record.origin === "creation" ? CREATED_TITLE : record.message,
          origin: record.origin,
          ...(record.originId ? { originId: record.originId } : {}),
          ...(record.originLabel ? { originLabel: record.originLabel } : {}),
          ...(record.person ? { person: record.person } : {}),
          createdAt: record.createdAt,
          current: record === newest && headHash !== undefined,
          ...(diffusion && { diffusion }),
        };
      })
      .reverse();
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/deleted-artboards", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    const records = store.listVersionRecords(req.params.pageId);
    const gone = new Map<string, { deletedIn: VersionRecord; lastIn: VersionRecord; artboard: ManifestArtboard }>();
    let previous = new Map<string, ManifestArtboard>();
    records.forEach((record, i) => {
      const present = artboardsOf(store, record);
      for (const [file, artboard] of previous) if (!present.has(file)) gone.set(file, { deletedIn: record, lastIn: records[i - 1], artboard });
      for (const file of present.keys()) gone.delete(file);
      previous = present;
    });
    return [...gone]
      .map(([file, { deletedIn, lastIn, artboard }]): DeletedArtboard => ({
        file,
        ...(artboard.title ? { title: artboard.title } : {}),
        deletedBy: deletedIn.origin === "restore" || deletedIn.origin === "user" || deletedIn.origin === "creation" || deletedIn.origin === "tweak" ? "user" : "claude",
        origin: deletedIn.origin,
        ...(deletedIn.originId ? { originId: deletedIn.originId } : {}),
        ...(deletedIn.originLabel ? { originLabel: deletedIn.originLabel } : {}),
        ...(deletedIn.person ? { person: deletedIn.person } : {}),
        deletedAt: deletedIn.createdAt,
        lastVersionId: lastIn.id,
        width: artboard.width,
        height: artboard.height,
      }))
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  });

  // Restores ONE artboard to its state in a page version: a new page version where only that file (and, when the
  // artboard is not on the page now, its manifest entry) changes. Also puts a deleted artboard back, and undoes both.
  app.post<{ Params: { pageId: string }; Body: Partial<RestoreArtboardRequest> }>("/api/pages/:pageId/artboards/restore", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    const { file, versionId, timeZone } = req.body ?? {};
    if (typeof file !== "string" || !isSafePath(file)) return reply.code(400).send({ error: "file is required" });
    if (!requiredString(versionId)) return reply.code(400).send({ error: "versionId is required" });
    if (!validTimeZone(timeZone)) return reply.code(400).send({ error: "invalid timeZone" });

    const records = store.listVersionRecords(req.params.pageId);
    const target = records.find((r) => r.id === versionId);
    if (!target) return reply.code(404).send({ error: "version not found" });
    const head = records[records.length - 1];
    const onPage = artboardsOf(store, head).has(file);
    const targetHash = target.files[file];
    if (targetHash === head.files[file] && (targetHash === undefined || onPage)) {
      return reply.code(409).send({ error: "the artboard already is in that state" });
    }

    const files = { ...head.files };
    if (targetHash === undefined) delete files[file];
    else files[file] = targetHash;
    const manifestHash = head.files[MANIFEST_PATH];
    if (manifestHash !== undefined && onPage !== (targetHash !== undefined)) {
      const stored = JSON.parse(store.blobText(manifestHash)) as { artboards?: { file: string }[]; elements?: Record<string, unknown>[] };
      // Deleting: what is anchored to the artboard stays where it was, arrows aiming at it go.
      const manifest = targetHash === undefined ? manifestWithoutArtboard(stored, file) : stored;
      const artboards = stored.artboards ?? [];
      const targetManifestHash = target.files[MANIFEST_PATH];
      const formerEntry =
        targetManifestHash === undefined
          ? undefined
          : (JSON.parse(store.blobText(targetManifestHash)) as { artboards?: { file: string }[] }).artboards?.find((a) => a.file === file);
      manifest.artboards = targetHash === undefined ? artboards.filter((a) => a.file !== file) : [...artboards.filter((a) => a.file !== file), formerEntry ?? { file }];
      files[MANIFEST_PATH] = store.putText(JSON.stringify(manifest, null, 2));
    }

    const changes = contentChanges(records, file);
    const previousVersionId = head.files[file] === undefined ? head.id : changes[changes.length - 1].id;
    const message =
      targetHash === undefined ? PUT_BACK_UNDONE_MESSAGE : !onPage ? PUT_BACK_MESSAGE : `Version du ${formatDate(target.createdAt, timeZone)} restaurée`;
    const version = store.addVersionFromHashes(req.params.pageId, files, message, "restore", personRef(req));
    const response: RestoreArtboardResponse = { version, previousVersionId };
    return reply.code(201).send(response);
  });
}
