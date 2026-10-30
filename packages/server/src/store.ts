import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { componentFilesOf, projectComponents } from "./components.js";
import { restoredVersionMessage } from "./version-dates.js";
import {
  EMPTY_VIEW_SETTINGS,
  initialsOf,
  diffDiffusionStates,
  diffusionSummary,
  DESIGN_MD_PATH,
  DESIGN_SYSTEM_TOKENS_PATH,
  ARTBOARD_GAP,
  MANIFEST_PATH,
  canvasElementSummary,
  defaultManifest,
  parseManifest,
  manifestWithoutArtboard,
  starterPageFiles,
  NEUTRAL_DESIGN_SYSTEM_ID,
  NEUTRAL_TOKENS_CSS,
  parseTokens,
  setToken,
  PROJECT_STYLE_PATH,
  NEUTRAL_TOKENS_PAGE_HTML,
  type DesignSystem,
  type DesignMdAuthor,
  type DesignMdVersion,
  type ProjectAsset,
} from "@redline/shared";
import type {
  Person,
  ComponentInfo,
  DiffusionInfo,
  DiffusionState,
  Conversation,
  ConversationMessage,
  CreateThreadRequest,
  ThreadRendering,
  TweakValues,
  ThreadTarget,
  ManifestElement,
  ManifestElementKind,
  AgentHello,
  AgentInfo,
  RefusedAgent,
  AgentKind,
  Effort,
  AgentStatus,
  CreatedPage,
  Page,
  PageViewSettings,
  PageCreator,
  ModelChoice,
  PageVersionSummary,
  Project,
  ProjectUsingDesignSystem,
  ServerEvent,
  SessionKind,
  Thread,
  ThreadContext,
  ThreadReply,
  ThreadStatus,
  VersionOrigin,
  WorkItem,
} from "@redline/shared";

/** Which agent a hello comes from: one per machine and folder. */
type AgentIdentity = Pick<AgentHello, "machine" | "folder" | "kind" | "projectIds" | "projectId">;

export class Store {
  private readonly db: Database.Database;
  private readonly blobDir: string;
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private serverBuildHash: string | undefined;

  constructor(dataDir: string) {
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, "redline.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        design_system TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id),
        files TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'terminal'
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id),
        number INTEGER NOT NULL,
        artboard TEXT NOT NULL,
        selector TEXT NOT NULL,
        x_pct REAL NOT NULL,
        y_pct REAL NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (page_id, number)
      );
      CREATE TABLE IF NOT EXISTS thread_replies (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS page_view_settings (
        page_id TEXT PRIMARY KEY REFERENCES pages(id),
        settings TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (machine, folder)
      );
      CREATE TABLE IF NOT EXISTS design_systems (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        page_id TEXT NOT NULL REFERENCES pages(id)
      );
      CREATE TABLE IF NOT EXISTS design_system_diffusions (
        design_system_id TEXT NOT NULL REFERENCES design_systems(project_id),
        number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        summary TEXT NOT NULL,
        tokens_hash TEXT NOT NULL,
        components_hash TEXT NOT NULL,
        design_md_hash TEXT NOT NULL,
        component_list_hash TEXT NOT NULL,
        index_hash TEXT NOT NULL,
        component_files_hash TEXT,
        PRIMARY KEY (design_system_id, number)
      );
      CREATE TABLE IF NOT EXISTS design_system_diffusion_undos (
        design_system_id TEXT NOT NULL REFERENCES design_systems(project_id),
        number INTEGER NOT NULL,
        undone_at TEXT NOT NULL,
        PRIMARY KEY (design_system_id, number)
      );
      CREATE TABLE IF NOT EXISTS project_files (
        project_id TEXT NOT NULL REFERENCES projects(id),
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE TABLE IF NOT EXISTS design_md_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id),
        title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        agent_id TEXT,
        context TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_created_pages (
        work_id TEXT NOT NULL,
        page_id TEXT NOT NULL REFERENCES pages(id),
        attached INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (work_id, page_id)
      );
      CREATE TABLE IF NOT EXISTS work_queue (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        state TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent_id TEXT,
        item TEXT NOT NULL,
        takeover_item TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at TEXT,
        retry_limit INTEGER,
        message TEXT
      );
      -- The projects each project agent serves: a folder can be linked to several, a project has at most one agent.
      CREATE TABLE IF NOT EXISTS agent_projects (
        project_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refused_agents (
        machine TEXT NOT NULL,
        folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        refused_at TEXT NOT NULL,
        PRIMARY KEY (machine, folder)
      );
      UPDATE agents SET status = 'offline';
    `);
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!agentColumns.some((c) => c.name === "project_id")) this.db.exec("ALTER TABLE agents ADD COLUMN project_id TEXT");
    // agents.project_id held the single project of an agent before agent_projects; it is only read to migrate.
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key = 'agent_projects_migrated'").get()) {
      this.db.exec("INSERT OR IGNORE INTO agent_projects (project_id, agent_id) SELECT project_id, id FROM agents WHERE project_id IS NOT NULL");
      this.db.exec("INSERT INTO settings (key, value) VALUES ('agent_projects_migrated', '1')");
    }
    if (!agentColumns.some((c) => c.name === "model")) this.db.exec("ALTER TABLE agents ADD COLUMN model TEXT");
    if (!agentColumns.some((c) => c.name === "build_hash")) this.db.exec("ALTER TABLE agents ADD COLUMN build_hash TEXT");
    if (!agentColumns.some((c) => c.name === "effort")) this.db.exec("ALTER TABLE agents ADD COLUMN effort TEXT");
    const refusedColumns = this.db.prepare("PRAGMA table_info(refused_agents)").all() as { name: string }[];
    if (!refusedColumns.some((c) => c.name === "project_id")) this.db.exec("ALTER TABLE refused_agents ADD COLUMN project_id TEXT");
    const columnsOf = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const addColumn = (table: string, column: string, definition: string) => {
      if (!columnsOf(table).includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    // Page types were removed (2026-10-22); the column was NOT NULL, so databases from before must drop it.
    if (columnsOf("pages").includes("type")) this.db.exec("ALTER TABLE pages DROP COLUMN type");
    addColumn("design_systems", "current_diffusion", "INTEGER");
    addColumn("design_system_diffusions", "component_files_hash", "TEXT");
    addColumn("design_system_diffusions", "rolled_back_to", "INTEGER");
    addColumn("pages", "created_by", "TEXT NOT NULL DEFAULT 'user'");
    // The signed-in person who wrote a human message or started a conversation; NULL before the SSO and without it.
    addColumn("threads", "person_id", "TEXT");
    addColumn("thread_replies", "person_id", "TEXT");
    addColumn("conversations", "person_id", "TEXT");
    addColumn("conversation_messages", "person_id", "TEXT");
    // On a design system's page: the project the thread or conversation was started from, whose agent runs its work.
    addColumn("threads", "via_project_id", "TEXT");
    addColumn("conversations", "via_project_id", "TEXT");
    // Same for what a person (or Claude, for the requesting person) did: page versions, DESIGN.md / tokens versions and pages.
    addColumn("versions", "person_id", "TEXT");
    addColumn("design_md_versions", "person_id", "TEXT");
    addColumn("pages", "person_id", "TEXT");
    // The old per-project boolean (default 0) becomes a nullable override of the global setting: only an explicit "allow" is kept.
    if (!columnsOf("projects").includes("takeover_override")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN takeover_override INTEGER");
      if (columnsOf("projects").includes("allow_global_takeover")) {
        this.db.exec("UPDATE projects SET takeover_override = 1 WHERE allow_global_takeover = 1");
      }
    }
    // One routing rule: a project that never had a project agent and has no override keeps being served by the global agent.
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key = 'routing_rule_migrated'").get()) {
      this.db.exec(
        "UPDATE projects SET takeover_override = 1 WHERE takeover_override IS NULL AND id NOT IN (SELECT project_id FROM agents WHERE project_id IS NOT NULL)",
      );
      this.db.exec("INSERT INTO settings (key, value) VALUES ('routing_rule_migrated', '1')");
    }
    // When the project (or design system) was archived: read-only, hidden from sessions, deletable.
    addColumn("projects", "archived_at", "TEXT");
    // When the page was archived: read-only, out of the page lists and of sessions, deletable.
    addColumn("pages", "archived_at", "TEXT");
    addColumn("pages", "held_by", "TEXT");
    addColumn("pages", "held_at", "TEXT");
    addColumn("versions", "origin_id", "TEXT");
    addColumn("versions", "origin_label", "TEXT");
    addColumn("versions", "diffusion", "INTEGER");
    addColumn("threads", "element_name", "TEXT");
    addColumn("threads", "rendering", "TEXT");
    addColumn("threads", "cell", "TEXT");
    addColumn("threads", "target_kind", "TEXT NOT NULL DEFAULT 'element'");
    addColumn("threads", "element_id", "TEXT");
    addColumn("threads", "element_kind", "TEXT");
    addColumn("threads", "element_summary", "TEXT");
    addColumn("thread_replies", "created_page_ids", "TEXT");
    addColumn("conversation_messages", "created_page_ids", "TEXT");
    addColumn("conversation_messages", "targets", "TEXT");
    addColumn("design_md_versions", "path", `TEXT NOT NULL DEFAULT '${DESIGN_MD_PATH}'`);
    addColumn("design_md_versions", "origin", "TEXT NOT NULL DEFAULT 'user'");
    addColumn("design_md_versions", "origin_id", "TEXT");
    addColumn("design_md_versions", "origin_label", "TEXT");
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    if (!threadColumns.some((c) => c.name === "session_id")) this.db.exec("ALTER TABLE threads ADD COLUMN session_id TEXT");
    if (!threadColumns.some((c) => c.name === "agent_id")) this.db.exec("ALTER TABLE threads ADD COLUMN agent_id TEXT");
    for (const column of ["context", "new_session", "session_seed"]) {
      if (!threadColumns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE threads ADD COLUMN ${column} TEXT`);
    }
    this.db.exec("UPDATE versions SET origin = 'creation' WHERE origin = 'terminal' AND message = 'Page created'");
    if (!this.getDesignSystem(NEUTRAL_DESIGN_SYSTEM_ID)) {
      this.createDesignSystem("Neutral", { [DESIGN_SYSTEM_TOKENS_PATH]: NEUTRAL_TOKENS_CSS, "index.html": NEUTRAL_TOKENS_PAGE_HTML }, NEUTRAL_DESIGN_SYSTEM_ID);
    }
    this.moveDesignSystemTokensToProjects();
    this.giveProjectsTheirStyle();
    this.giveDesignSystemsTheirFirstDiffusion();
  }

  /** Replaces the persisted work queue (see `PageLock`) with `rows`, in order. */
  saveWorkQueue(rows: PersistedWork[]): void {
    const insert = this.db.prepare(
      `INSERT INTO work_queue (id, position, state, project_id, agent_id, item, takeover_item, attempts, retry_at, retry_limit, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM work_queue").run();
      rows.forEach((row, position) =>
        insert.run(
          row.item.id,
          position,
          row.state,
          row.projectId,
          row.agentId ?? null,
          JSON.stringify(row.item),
          row.takeoverItem ? JSON.stringify(row.takeoverItem) : null,
          row.attempts,
          row.retryAt ?? null,
          row.limit === undefined ? null : row.limit ? 1 : 0,
          row.message ?? null,
        ),
      );
    })();
  }

  loadWorkQueue(): PersistedWork[] {
    const rows = this.db.prepare("SELECT * FROM work_queue ORDER BY position").all() as {
      state: PersistedWork["state"];
      project_id: string;
      agent_id: string | null;
      item: string;
      takeover_item: string | null;
      attempts: number;
      retry_at: string | null;
      retry_limit: number | null;
      message: string | null;
    }[];
    return rows.map((r) => ({
      state: r.state,
      projectId: r.project_id,
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
      item: JSON.parse(r.item) as WorkItem,
      ...(r.takeover_item ? { takeoverItem: JSON.parse(r.takeover_item) as WorkItem } : {}),
      attempts: r.attempts,
      ...(r.retry_at ? { retryAt: r.retry_at } : {}),
      ...(r.retry_limit === null ? {} : { limit: r.retry_limit === 1 }),
      ...(r.message === null ? {} : { message: r.message }),
    }));
  }

  /**
   * A design system is a project (same id) with any number of pages, plus project-level `tokens.css` and DESIGN.md.
   * `files` are those of its first page; a `tokens.css` among them is stored at the project level instead.
   */
  createDesignSystem(title: string, files: Record<string, string>, id: string = randomUUID()): DesignSystem {
    this.insertProject(title, id, "", null);
    const { [DESIGN_SYSTEM_TOKENS_PATH]: tokens, ...pageFiles } = files;
    if (tokens !== undefined) this.saveDesignMd(id, DESIGN_SYSTEM_TOKENS_PATH, Buffer.from(tokens, "utf8"));
    const page = this.createPage(id, title, pageFiles);
    this.db.prepare("INSERT INTO design_systems (project_id, page_id) VALUES (?, ?)").run(id, page.id);
    this.createDiffusion(id, "user", "Initial diffusion");
    return { id, title, pageId: page.id };
  }

  /** Migration (every store start, idempotent): a design system without diffusion gets diffusion 1 from its current files. */
  private giveDesignSystemsTheirFirstDiffusion(): void {
    for (const { id } of this.listDesignSystems()) {
      if (this.currentDiffusion(id) === undefined) this.createDiffusion(id, "migration", "Initial diffusion");
    }
  }

  /**
   * The draft of a design system: its current project-level tokens and DESIGN.md and the components of its pages.
   * It becomes a diffusion with `createDiffusion`; "pending" = the draft differs from the current diffusion.
   */
  designSystemDraft(id: string): { state: DiffusionState; componentsCss: string; componentFiles: Record<string, string>; assembly: ReturnType<typeof projectComponents> } {
    const assembly = projectComponents(this, id);
    return {
      componentFiles: componentFilesOf(this, id),
      state: {
        tokensCss: this.readProjectText(id, DESIGN_SYSTEM_TOKENS_PATH),
        designMd: this.readProjectText(id, DESIGN_MD_PATH),
        components: assembly.components.map(({ name, hash }) => ({ name, hash })),
      },
      componentsCss: assembly.css,
      assembly,
    };
  }

  /** The draft of a design system with what differs from its current diffusion (the pending changes). */
  pendingDiffusion(designSystemId: string): { draft: ReturnType<Store["designSystemDraft"]>; pending: ReturnType<typeof diffDiffusionStates> } {
    const draft = this.designSystemDraft(designSystemId);
    const current = this.currentDiffusion(designSystemId)!;
    return { draft, pending: diffDiffusionStates(this.diffusionState(designSystemId, current.number), draft.state) };
  }

  /** Freezes the draft of a design system as its next diffusion and makes it the current one. Diffusions are never edited. */
  createDiffusion(designSystemId: string, origin: DiffusionInfo["origin"], summary?: string): DiffusionInfo {
    const draft = this.designSystemDraft(designSystemId);
    const current = this.currentDiffusion(designSystemId);
    const text = summary ?? diffusionSummary(diffDiffusionStates(current ? this.diffusionState(designSystemId, current.number) : { tokensCss: "", designMd: "", components: [] }, draft.state));
    const blob = (content: string) => this.putBlob(Buffer.from(content, "utf8"));
    const last = this.db.prepare("SELECT MAX(number) AS n FROM design_system_diffusions WHERE design_system_id = ?").get(designSystemId) as { n: number | null };
    const number = (last.n ?? 0) + 1;
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO design_system_diffusions
         (design_system_id, number, created_at, origin, summary, tokens_hash, components_hash, design_md_hash, component_list_hash, index_hash, component_files_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        designSystemId, number, createdAt, origin, text,
        blob(draft.state.tokensCss), blob(draft.componentsCss), blob(draft.state.designMd),
        blob(JSON.stringify(draft.assembly.components)), blob(JSON.stringify(draft.assembly.indexes)), blob(JSON.stringify(draft.componentFiles)),
      );
    this.db.prepare("UPDATE design_systems SET current_diffusion = ? WHERE project_id = ?").run(number, designSystemId);
    return { number, createdAt, origin, summary: text, undone: false };
  }

  /**
   * Undo: the current diffusion stays listed, marked undone, and projects use the closest earlier diffusion that is not undone.
   * Undefined when there is none (the first diffusion cannot be undone).
   */
  undoDiffusion(designSystemId: string): DiffusionInfo | undefined {
    const current = this.currentDiffusion(designSystemId);
    const previous = current && this.listDiffusions(designSystemId).find((d) => d.number < current.number && !d.undone);
    if (!current || !previous) return undefined;
    this.db.prepare("INSERT INTO design_system_diffusion_undos (design_system_id, number, undone_at) VALUES (?, ?, ?)").run(designSystemId, current.number, now());
    this.db.prepare("UPDATE design_systems SET current_diffusion = ? WHERE project_id = ?").run(previous.number, designSystemId);
    return previous;
  }

  /** Roll back: a new entry of the list that points at the same files as diffusion `target` (no new blob); it becomes the current diffusion. The draft is untouched. */
  rollbackDiffusion(designSystemId: string, target: number): DiffusionInfo {
    const last = this.db.prepare("SELECT MAX(number) AS n FROM design_system_diffusions WHERE design_system_id = ?").get(designSystemId) as { n: number };
    const number = last.n + 1;
    const createdAt = now();
    const summary = `Rolled back to diffusion ${target}`;
    this.db
      .prepare(
        `INSERT INTO design_system_diffusions
         (design_system_id, number, created_at, origin, summary, tokens_hash, components_hash, design_md_hash, component_list_hash, index_hash, component_files_hash, rolled_back_to)
         SELECT design_system_id, ?, ?, 'rollback', ?, tokens_hash, components_hash, design_md_hash, component_list_hash, index_hash, component_files_hash, ?
         FROM design_system_diffusions WHERE design_system_id = ? AND number = ?`,
      )
      .run(number, createdAt, summary, target, designSystemId, target);
    this.db.prepare("UPDATE design_systems SET current_diffusion = ? WHERE project_id = ?").run(number, designSystemId);
    return { number, createdAt, origin: "rollback", summary, rolledBackTo: target, undone: false };
  }

  /** The diffusion projects use, or undefined before the design system has one. */
  currentDiffusion(designSystemId: string): DiffusionInfo | undefined {
    const row = this.db.prepare("SELECT current_diffusion AS n FROM design_systems WHERE project_id = ?").get(designSystemId) as { n: number | null } | undefined;
    return row?.n == null ? undefined : this.listDiffusions(designSystemId).find((d) => d.number === row.n);
  }

  /** Diffusions of a design system, newest first. */
  listDiffusions(designSystemId: string): DiffusionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT d.number, d.created_at AS createdAt, d.origin, d.summary, d.rolled_back_to AS rolledBackTo, u.number IS NOT NULL AS undone
         FROM design_system_diffusions d
         LEFT JOIN design_system_diffusion_undos u ON u.design_system_id = d.design_system_id AND u.number = d.number
         WHERE d.design_system_id = ? ORDER BY d.number DESC`,
      )
      .all(designSystemId) as (Omit<DiffusionInfo, "undone" | "rolledBackTo"> & { rolledBackTo: number | null; undone: number })[];
    return rows.map(({ rolledBackTo, undone, ...rest }) => ({ ...rest, undone: undone === 1, ...(rolledBackTo !== null && { rolledBackTo }) }));
  }

  /** One file of a diffusion (`tokens.css`, `components.css`, `DESIGN.md`, `components.json` the component list, `index.json` the per-page index, `component-files.json` the component files by path). */
  readDiffusionFile(designSystemId: string, number: number, file: "tokens.css" | "components.css" | "DESIGN.md" | "components.json" | "index.json" | "component-files.json"): string | undefined {
    const column = { "tokens.css": "tokens_hash", "components.css": "components_hash", "DESIGN.md": "design_md_hash", "components.json": "component_list_hash", "index.json": "index_hash", "component-files.json": "component_files_hash" }[file];
    const row = this.db.prepare(`SELECT ${column} AS hash FROM design_system_diffusions WHERE design_system_id = ? AND number = ?`).get(designSystemId, number) as { hash: string | null } | undefined;
    return row?.hash ? readFileSync(join(this.blobDir, row.hash), "utf8") : undefined;
  }

  /** The components of a diffusion (`components.json`). */
  diffusionComponents(designSystemId: string, number: number): ComponentInfo[] {
    return JSON.parse(this.readDiffusionFile(designSystemId, number, "components.json") ?? "[]") as ComponentInfo[];
  }

  /** The component files of a diffusion by path (`component-files.json`). */
  diffusionComponentFiles(designSystemId: string, number: number): Record<string, string> {
    return JSON.parse(this.readDiffusionFile(designSystemId, number, "component-files.json") ?? "{}") as Record<string, string>;
  }

  /** The per-page component index text of a diffusion, by page id (`index.json`). */
  diffusionPageIndexes(designSystemId: string, number: number): Record<string, string> {
    return JSON.parse(this.readDiffusionFile(designSystemId, number, "index.json") ?? "{}") as Record<string, string>;
  }

  /** A diffusion as the diff reads it. */
  diffusionState(designSystemId: string, number: number): DiffusionState {
    const components = this.diffusionComponents(designSystemId, number);
    return {
      tokensCss: this.readDiffusionFile(designSystemId, number, "tokens.css") ?? "",
      designMd: this.readDiffusionFile(designSystemId, number, "DESIGN.md") ?? "",
      components: components.map(({ name, hash }) => ({ name, hash })),
    };
  }

  getDesignSystem(id: string): DesignSystem | undefined {
    const row = this.db
      .prepare(
        "SELECT p.id, p.title, d.page_id AS pageId, p.archived_at AS archivedAt FROM design_systems d JOIN projects p ON p.id = d.project_id WHERE p.id = ?",
      )
      .get(id) as DesignSystemRow | undefined;
    return row && toDesignSystem(row);
  }

  /** Every design system, archived ones and the hidden Neutral record included. */
  listDesignSystems(): DesignSystem[] {
    const rows = this.db
      .prepare(
        "SELECT p.id, p.title, d.page_id AS pageId, p.archived_at AS archivedAt FROM design_systems d JOIN projects p ON p.id = d.project_id ORDER BY p.created_at, p.rowid",
      )
      .all() as DesignSystemRow[];
    return rows.map(toDesignSystem);
  }

  /** The design systems a user or session can pick: every one but the archived ones and the hidden Neutral record. */
  listChoosableDesignSystems(): DesignSystem[] {
    return this.listDesignSystems().filter((designSystem) => designSystem.id !== NEUTRAL_DESIGN_SYSTEM_ID && !designSystem.archivedAt);
  }

  /** Archived design systems, for their own screen. */
  listArchivedDesignSystems(): DesignSystem[] {
    return this.listDesignSystems().filter((designSystem) => designSystem.archivedAt);
  }

  /** Every thread and conversation with the page and project they belong to (design system pages included). */
  listSessionOrigins(): SessionOrigin[] {
    const select = (table: "threads" | "conversations") =>
      `SELECT t.id, '${table === "threads" ? "thread" : "conversation"}' AS kind, t.page_id AS pageId, pg.title AS pageTitle,
              pg.project_id AS projectId, pr.title AS projectTitle, t.created_at AS createdAt
       FROM ${table} t JOIN pages pg ON pg.id = t.page_id JOIN projects pr ON pr.id = pg.project_id`;
    return this.db.prepare(`${select("threads")} UNION ALL ${select("conversations")}`).all() as SessionOrigin[];
  }

  /** The agent linked to the project, online or not. */
  projectAgentId(projectId: string): string | undefined {
    const row = this.db.prepare("SELECT agent_id AS id FROM agent_projects WHERE project_id = ?").get(projectId) as { id: string } | undefined;
    return row?.id;
  }

  /** True while the agent is linked to a project; a project agent replaced by a newer one, and a global agent, are not. */
  isProjectAgent(agentId: string): boolean {
    return this.db.prepare("SELECT 1 FROM agent_projects WHERE agent_id = ?").get(agentId) !== undefined;
  }

  /** Projects (design systems excluded) whose design system is `designSystemId`, archived ones marked. */
  projectsUsingDesignSystem(designSystemId: string): ProjectUsingDesignSystem[] {
    const rows = this.db
      .prepare(
        "SELECT id, title, archived_at AS archivedAt FROM projects WHERE design_system = ? AND id NOT IN (SELECT project_id FROM design_systems) ORDER BY created_at, rowid",
      )
      .all(designSystemId) as { id: string; title: string; archivedAt: string | null }[];
    return rows.map(({ id, title, archivedAt }) => ({ id, title, ...(archivedAt ? { archived: true as const } : {}) }));
  }

  /** The design system a page belongs to (one of its own pages), if any. */
  designSystemOfPage(pageId: string): DesignSystem | undefined {
    const row = this.db
      .prepare(
        `SELECT p.id, p.title, d.page_id AS pageId, p.archived_at AS archivedAt FROM pages pg JOIN design_systems d ON d.project_id = pg.project_id
         JOIN projects p ON p.id = d.project_id WHERE pg.id = ?`,
      )
      .get(pageId) as DesignSystemRow | undefined;
    return row && toDesignSystem(row);
  }

  /**
   * Design systems stored before tokens became project-level kept `tokens.css` in their page: move it to the project
   * (as its first version) and record a page version without it. Idempotent.
   */
  private moveDesignSystemTokensToProjects(): void {
    for (const designSystem of this.listDesignSystems()) {
      for (const page of this.listPages(designSystem.id)) {
        const hash = page.version.files[DESIGN_SYSTEM_TOKENS_PATH];
        if (hash === undefined) continue;
        const { [DESIGN_SYSTEM_TOKENS_PATH]: _moved, ...rest } = page.version.files;
        this.db.transaction(() => {
          if (!this.readProjectFile(designSystem.id, DESIGN_SYSTEM_TOKENS_PATH)) {
            this.saveDesignMd(designSystem.id, DESIGN_SYSTEM_TOKENS_PATH, readFileSync(join(this.blobDir, hash)));
          }
          this.insertVersion(page.id, JSON.stringify(rest), "Tokens moved to the design system", "creation");
        })();
      }
    }
  }

  listPageIds(): string[] {
    return (this.db.prepare("SELECT id FROM pages ORDER BY created_at, rowid").all() as { id: string }[]).map((r) => r.id);
  }

  isDesignSystemPage(pageId: string): boolean {
    return this.designSystemOfPage(pageId) !== undefined;
  }

  close(): void {
    this.db.close();
  }

  /** Creates the person on their first visit; their name and e-mail are refreshed when the SSO gives other ones. */
  savePerson(id: string, name: string, email: string): Person {
    const known = this.db.prepare("SELECT name, email FROM people WHERE id = ?").get(id) as { name: string; email: string } | undefined;
    if (!known) this.db.prepare("INSERT INTO people (id, name, email, created_at) VALUES (?, ?, ?, ?)").run(id, name, email, new Date().toISOString());
    else if (known.name !== name || known.email !== email) this.db.prepare("UPDATE people SET name = ?, email = ? WHERE id = ?").run(name, email, id);
    return { id, name, email, initials: initialsOf(name, id) };
  }

  getPerson(id: string | null | undefined): Person | undefined {
    if (!id) return undefined;
    const row = this.db.prepare("SELECT id, name, email FROM people WHERE id = ?").get(id) as { id: string; name: string; email: string } | undefined;
    return row && { ...row, initials: initialsOf(row.name, row.id) };
  }

  /** The person a work item works for, read when the item is sent: see `requestingPersonOfThread`. */
  requestingPersonOfItem(item: WorkItem): Person | undefined {
    if (item.conversationId) return this.requestingPersonOfConversation(item.conversationId);
    const first = item.threads[0];
    return first && this.requestingPersonOfThread(first.threadId);
  }

  /** The project a work item's design system page was opened from (its conversation's, else its first thread's); undefined elsewhere. */
  viaProjectOfItem(item: WorkItem): string | undefined {
    const row = item.conversationId
      ? this.db.prepare("SELECT via_project_id AS via FROM conversations WHERE id = ?").get(item.conversationId)
      : item.threads[0] && this.db.prepare("SELECT via_project_id AS via FROM threads WHERE id = ?").get(item.threads[0].threadId);
    return (row as { via: string | null } | undefined)?.via ?? undefined;
  }

  /** `viaProjectId` when the page belongs to a design system that project uses; null otherwise (it is then ignored). */
  private viaProjectOf(pageId: string, viaProjectId: string | undefined): string | null {
    const designSystemId = this.getPage(pageId)?.projectId;
    if (!viaProjectId || !designSystemId || !this.isDesignSystemProject(designSystemId)) return null;
    return this.projectsUsingDesignSystem(designSystemId).some((p) => p.id === viaProjectId && !p.archived) ? viaProjectId : null;
  }

  /**
   * The person a run of Claude works for: the author of the message that started it, i.e. the latest human message of
   * the thread (its comment, or its latest user reply) at the time the run starts. Undefined for comments from before the SSO and without SSO.
   */
  requestingPersonOfThread(threadId: string): Person | undefined {
    const reply = this.db
      .prepare("SELECT person_id FROM thread_replies WHERE thread_id = ? AND author = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as { person_id: string | null } | undefined;
    if (reply) return this.getPerson(reply.person_id);
    const thread = this.db.prepare("SELECT person_id FROM threads WHERE id = ?").get(threadId) as { person_id: string | null } | undefined;
    return this.getPerson(thread?.person_id);
  }

  /** Same for a conversation: the author of its latest human message. */
  requestingPersonOfConversation(conversationId: string): Person | undefined {
    const message = this.db
      .prepare("SELECT person_id FROM conversation_messages WHERE conversation_id = ? AND author = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(conversationId) as { person_id: string | null } | undefined;
    return this.getPerson(message?.person_id);
  }

  /** Calls `listener` after every change the web UI shows (new thread or reply, new version). Returns the unsubscribe function. */
  onChange(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private readonly updatingAgents = new Set<string>();
  private readonly updateErrors = new Map<string, string>();

  /** Id of the online project agent serving the project. */
  findOnlineProjectAgentId(projectId: string): string | undefined {
    const row = this.db.prepare("SELECT a.id FROM agent_projects ap JOIN agents a ON a.id = ap.agent_id WHERE ap.project_id = ? AND a.status = 'online'").get(projectId) as
      | { id: string }
      | undefined;
    return row?.id;
  }

  /** The agents' token, generated on first read. */
  getAgentToken(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'agent_token'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? this.regenerateAgentToken();
  }

  regenerateAgentToken(): string {
    const token = `abt_${randomBytes(24).toString("hex")}`;
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('agent_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(token);
    return token;
  }

  /** Records an agent as online; one entry per machine and folder. */
  markAgentOnline({ machine, folder, kind, projectIds = [], model, effort, buildHash }: Omit<AgentIdentity, "projectId"> & Pick<AgentHello, "model" | "effort" | "buildHash">): string {
    this.db
      .prepare(
        `INSERT INTO agents (id, machine, folder, kind, status, last_seen_at, model, effort, build_hash) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
         ON CONFLICT(machine, folder) DO UPDATE SET kind = excluded.kind, status = 'online', last_seen_at = excluded.last_seen_at, model = excluded.model, effort = excluded.effort, build_hash = excluded.build_hash`,
      )
      .run(randomUUID(), machine, folder, kind, now(), model ?? null, effort ?? null, buildHash ?? null);
    this.db.prepare("DELETE FROM refused_agents WHERE machine = ? AND folder = ?").run(machine, folder);
    const id = (this.db.prepare("SELECT id FROM agents WHERE machine = ? AND folder = ?").get(machine, folder) as { id: string }).id;
    // The agent now serves exactly its folder's projects, taking them from any agent that served them before.
    this.db.prepare("DELETE FROM agent_projects WHERE agent_id = ?").run(id);
    const link = this.db.prepare("INSERT INTO agent_projects (project_id, agent_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET agent_id = excluded.agent_id");
    for (const projectId of projectIds) link.run(projectId, id);
    this.updatingAgents.delete(id);
    this.updateErrors.delete(id);
    return id;
  }

  markAgentOffline(id: string): void {
    this.db.prepare("UPDATE agents SET status = 'offline', last_seen_at = ? WHERE id = ?").run(now(), id);
    this.updatingAgents.delete(id);
  }

  /** Marks a connected agent as updating: it gets no new work until it reconnects or reports a failure. */
  markAgentUpdating(id: string): void {
    this.updatingAgents.add(id);
    this.updateErrors.delete(id);
  }

  isAgentUpdating(id: string): boolean {
    return this.updatingAgents.has(id);
  }

  /** The agent could not install the update and keeps its previous build: it takes work again, and the row shows why. */
  recordUpdateFailure(id: string, message: string): void {
    this.updatingAgents.delete(id);
    this.updateErrors.set(id, message);
  }

  /** The online project agent serving a project, other than the given machine and folder. */
  findOtherOnlineProjectAgent(projectId: string, machine: string, folder: string): { machine: string; folder: string } | undefined {
    return this.db
      .prepare(
        "SELECT a.machine, a.folder FROM agent_projects ap JOIN agents a ON a.id = ap.agent_id WHERE ap.project_id = ? AND a.status = 'online' AND NOT (a.machine = ? AND a.folder = ?)",
      )
      .get(projectId, machine, folder) as { machine: string; folder: string } | undefined;
  }

  /** The build hash of the CLI the server serves; connected agents running another build are listed as outdated. Undefined (development): no check. */
  setServerBuildHash(hash: string | undefined): void {
    this.serverBuildHash = hash;
  }

  getServerBuildHash(): string | undefined {
    return this.serverBuildHash;
  }

  isOutdated(buildHash: string | null | undefined): boolean {
    return this.serverBuildHash !== undefined && buildHash !== this.serverBuildHash;
  }

  listAgents(): AgentInfo[] {
    const rows = this.db
      .prepare("SELECT id, machine, folder, kind, status, last_seen_at AS lastSeenAt, model, effort, build_hash AS buildHash FROM agents ORDER BY machine, folder")
      .all() as (Omit<AgentInfo, "model" | "effort" | "outdated" | "updating" | "updateError"> & { model: string | null; effort: Effort | null; buildHash: string | null })[];
    return rows.map(({ model, effort, buildHash, ...agent }) => ({
      ...agent,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(agent.status === "online" && this.isOutdated(buildHash) ? { outdated: true as const } : {}),
      ...(this.updatingAgents.has(agent.id) ? { updating: true as const } : {}),
      ...(this.updateErrors.has(agent.id) ? { updateError: this.updateErrors.get(agent.id) } : {}),
    }));
  }

  /** Remembers an agent refused for its protocol until it connects again. */
  recordRefusedAgent({ machine, folder, kind, projectIds, projectId = projectIds?.[0] }: AgentIdentity): void {
    this.db
      .prepare(
        "INSERT INTO refused_agents (machine, folder, kind, project_id, refused_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(machine, folder) DO UPDATE SET kind = excluded.kind, project_id = excluded.project_id, refused_at = excluded.refused_at",
      )
      .run(machine, folder, kind, projectId ?? null, now());
  }

  listRefusedAgents(): RefusedAgent[] {
    const rows = this.db
      .prepare(
        `SELECT r.machine, r.folder, r.kind, p.title AS project, r.refused_at AS refusedAt
         FROM refused_agents r LEFT JOIN projects p ON p.id = r.project_id ORDER BY r.machine, r.folder`,
      )
      .all() as (Omit<RefusedAgent, "project"> & { project: string | null })[];
    return rows.map(({ project, ...agent }) => ({ ...agent, ...(project ? { project } : {}) }));
  }

  private insertProject(title: string, id: string, instructions: string, designSystem: string | null): Project {
    this.db
      .prepare("INSERT INTO projects (id, title, instructions, design_system, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, title, instructions, designSystem, now());
    return { id, title, instructions, designSystem, globalTakeover: this.getGlobalTakeover(), globalTakeoverOverride: null };
  }

  /** A project without a shared design system starts with an empty project style (an empty file: it counts as existing), which Claude fills in. */
  createProject(title: string, id: string = randomUUID(), instructions = "", chosenDesignSystem: string | null = null): Project {
    const designSystem = chosenDesignSystem === NEUTRAL_DESIGN_SYSTEM_ID ? null : chosenDesignSystem;
    const project = this.insertProject(title, id, instructions, designSystem);
    if (designSystem === null) this.saveDesignMd(id, PROJECT_STYLE_PATH, Buffer.alloc(0));
    return project;
  }

  /**
   * Points a project at a shared design system, or at none (null: its project style becomes its whole style). Pages follow the
   * `designSystem` of their manifest, so each page whose manifest says otherwise gets a version with the new value.
   */
  setProjectDesignSystem(projectId: string, chosenDesignSystem: string | null, origin: VersionOrigin, person?: Person): void {
    const designSystem = chosenDesignSystem === NEUTRAL_DESIGN_SYSTEM_ID ? null : chosenDesignSystem;
    const previous = this.sharedDesignSystemIdOfProject(projectId) ?? null;
    if (designSystem === null && previous !== null) {
      const style = this.startingStyle(projectId, previous);
      if (style !== undefined) this.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(style, "utf8"), { origin: "user", ...(person && { person }) });
    }
    this.db.prepare("UPDATE projects SET design_system = ? WHERE id = ?").run(designSystem, projectId);
    if (designSystem === null && !this.readProjectFile(projectId, PROJECT_STYLE_PATH)) {
      this.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.alloc(0));
    }
    for (const page of this.listPages(projectId)) {
      const { files } = this.readPageFiles(page.id)!;
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(files[MANIFEST_PATH] ?? "");
      } catch {
        continue;
      }
      if ((manifest.designSystem ?? null) === designSystem) continue;
      if (designSystem === null) delete manifest.designSystem;
      else manifest.designSystem = designSystem;
      this.addVersion(page.id, { ...files, [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n` }, designSystem === null ? "No shared design system" : "Design system changed", origin, person && { person });
    }
  }

  /** The project style after leaving `fromDesignSystem`: its current diffusion's tokens with the project's overrides on top; undefined (the overrides stay alone) when it has no diffusion. */
  private startingStyle(projectId: string, fromDesignSystem: string): string | undefined {
    const diffusion = this.currentDiffusion(fromDesignSystem);
    const base = diffusion && this.readDiffusionFile(fromDesignSystem, diffusion.number, "tokens.css");
    if (!base) return undefined;
    const overrides = parseTokens(this.readProjectText(projectId, PROJECT_STYLE_PATH));
    return overrides.reduce((css, token) => setToken(css, token.name, token.value), base);
  }

  /** True when `projectId` is a design system's own project (it has no project style: its `tokens.css` is the design system's). */
  isDesignSystemProject(projectId: string): boolean {
    return this.db.prepare("SELECT 1 FROM design_systems WHERE project_id = ?").get(projectId) !== undefined;
  }

  /** Existing projects without a shared design system get the neutral values as project style, so they render as before. Idempotent. */
  private giveProjectsTheirStyle(): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM projects WHERE design_system IS NULL AND id NOT IN (SELECT project_id FROM design_systems)
         AND id NOT IN (SELECT project_id FROM project_files WHERE path = ?)`,
      )
      .all(PROJECT_STYLE_PATH) as { id: string }[];
    for (const { id } of rows) this.saveDesignMd(id, PROJECT_STYLE_PATH, Buffer.from(NEUTRAL_TOKENS_CSS, "utf8"));
  }

  /** Projects (design systems excluded): the active ones by default, the archived ones, or both. */
  listProjects(which: "active" | "archived" | "all" = "active"): Project[] {
    const archived = { active: "AND p.archived_at IS NULL", archived: "AND p.archived_at IS NOT NULL", all: "" }[which];
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.instructions, p.design_system AS designSystem, p.takeover_override AS takeoverOverride, p.archived_at AS archivedAt,
                a.id AS agentId, a.machine, a.folder, a.status
         FROM projects p LEFT JOIN agent_projects ap ON ap.project_id = p.id LEFT JOIN agents a ON a.id = ap.agent_id
         WHERE p.id NOT IN (SELECT project_id FROM design_systems) ${archived}
         ORDER BY ${which === "archived" ? "p.archived_at DESC," : ""} p.created_at, p.rowid`,
      )
      .all() as {
      id: string;
      title: string;
      instructions: string;
      designSystem: string | null;
      takeoverOverride: number | null;
      archivedAt: string | null;
      agentId: string | null;
      machine: string;
      folder: string;
      status: AgentStatus;
    }[];
    const global = this.getGlobalTakeover();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      instructions: r.instructions,
      designSystem: r.designSystem,
      globalTakeover: r.takeoverOverride === null ? global : r.takeoverOverride === 1,
      globalTakeoverOverride: r.takeoverOverride === null ? null : r.takeoverOverride === 1,
      ...(r.agentId ? { agent: { id: r.agentId, machine: r.machine, folder: r.folder, status: r.status } } : {}),
      ...(r.archivedAt ? { archivedAt: r.archivedAt } : {}),
    }));
  }

  /** A project, archived or not (design systems excluded). */
  getProject(id: string): Project | undefined {
    return this.listProjects("all").find((p) => p.id === id);
  }

  /**
   * Deletes those of `candidates` (a deleted project's blobs) that nothing refers to any more: blobs are shared by content
   * hash, so one another project, page version, DESIGN.md version or diffusion still uses stays. Blobs written or reused less
   * than `minAgeMs` ago stay too (a request may have stored one and not recorded it yet): they come back as `tooYoung`.
   */
  collectGarbage(candidates: Iterable<string>, minAgeMs = BLOB_MIN_AGE_MS): { removed: number; tooYoung: string[] } {
    const inVersions = this.db.prepare("SELECT 1 FROM versions WHERE instr(files, ?) > 0 LIMIT 1");
    const elsewhere = BLOB_HASH_COLUMNS.map(({ table, column }) => this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`));
    const oldest = Date.now() - minAgeMs;
    const tooYoung: string[] = [];
    let removed = 0;
    for (const hash of new Set(candidates)) {
      if (!/^[0-9a-f]{64}$/.test(hash) || inVersions.get(`"${hash}"`) || elsewhere.some((query) => query.get(hash))) continue;
      const path = join(this.blobDir, hash);
      try {
        if (minAgeMs > 0 && statSync(path).mtimeMs > oldest) {
          tooYoung.push(hash);
          continue;
        }
        unlinkSync(path);
        removed += 1;
      } catch {
        // Already gone, or not removable now: nothing refers to it, a later delete may take it.
      }
    }
    return { removed, tooYoung };
  }

  /** The project (or design system) a page belongs to, without loading its files. */
  projectIdOfPage(pageId: string): string | undefined {
    return (this.db.prepare("SELECT project_id AS projectId FROM pages WHERE id = ?").get(pageId) as { projectId: string } | undefined)?.projectId;
  }

  /** True when the project or design system `id` is archived. */
  isArchived(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NOT NULL").get(id) !== undefined;
  }

  /** Archives (read-only, hidden from sessions) or unarchives a project or design system. */
  setArchived(id: string, archived: boolean): void {
    this.db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(archived ? now() : null, id);
  }

  /**
   * Deletes a project or design system for good, with its pages, versions, threads, conversations, files and diffusions.
   * Returns the blobs it referred to: they are shared by content hash, so `collectGarbage` removes only those now unused.
   */
  deleteProject(id: string): string[] {
    const pages = "SELECT id FROM pages WHERE project_id = ?";
    const blobs: string[] = [];
    for (const { files } of this.db.prepare(`SELECT files FROM versions WHERE page_id IN (${pages})`).all(id) as { files: string }[]) {
      blobs.push(...Object.values(JSON.parse(files) as Record<string, string>));
    }
    for (const { table, column, owner } of BLOB_HASH_COLUMNS) {
      for (const row of this.db.prepare(`SELECT ${column} AS hash FROM ${table} WHERE ${owner} = ?`).all(id) as { hash: string | null }[]) if (row.hash) blobs.push(row.hash);
    }
    this.db.transaction(() => {
      for (const sql of [
        ...pageRowDeletes(pages),
        "DELETE FROM design_system_diffusion_undos WHERE design_system_id = ?",
        "DELETE FROM design_system_diffusions WHERE design_system_id = ?",
        "DELETE FROM design_systems WHERE project_id = ?",
        "DELETE FROM pages WHERE project_id = ?",
        "DELETE FROM project_files WHERE project_id = ?",
        "DELETE FROM design_md_versions WHERE project_id = ?",
        "DELETE FROM work_queue WHERE project_id = ?",
        "DELETE FROM refused_agents WHERE project_id = ?",
        "UPDATE agents SET project_id = NULL WHERE project_id = ?",
        "DELETE FROM agent_projects WHERE project_id = ?",
        "DELETE FROM projects WHERE id = ?",
      ]) {
        this.db.prepare(sql).run(id);
      }
    })();
    return blobs;
  }

  /** Sets (true / false) or clears (null) the project's own takeover choice. */
  setTakeoverOverride(projectId: string, override: boolean | null): void {
    this.db.prepare("UPDATE projects SET takeover_override = ? WHERE id = ?").run(override === null ? null : override ? 1 : 0, projectId);
  }

  renameProject(projectId: string, title: string): void {
    this.db.prepare("UPDATE projects SET title = ? WHERE id = ?").run(title, projectId);
  }

  /** The instance-wide takeover setting (default: the thread waits for its project agent). */
  getGlobalTakeover(): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'global_takeover'").get() as { value: string } | undefined;
    return row?.value === "1";
  }

  setGlobalTakeover(allow: boolean): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('global_takeover', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(allow ? "1" : "0");
  }

  /** Id of an online global agent that is not updating, the most recently seen first. */
  findOnlineGlobalAgentId(): string | undefined {
    const rows = this.db.prepare("SELECT id FROM agents WHERE kind = 'global' AND status = 'online' ORDER BY last_seen_at DESC, rowid").all() as { id: string }[];
    return rows.find((row) => !this.updatingAgents.has(row.id))?.id;
  }

  getAgent(id: string): AgentInfo | undefined {
    return this.listAgents().find((a) => a.id === id);
  }

  projectExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== undefined;
  }

  /** Stores a project-level file (DESIGN.md or `assets/<name>`) under its content hash. */
  setProjectFile(projectId: string, path: string, content: Buffer): string {
    const hash = this.putBlob(content);
    this.db
      .prepare("INSERT INTO project_files (project_id, path, hash) VALUES (?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET hash = excluded.hash")
      .run(projectId, path, hash);
    return hash;
  }

  /** Saves a versioned project-level file (DESIGN.md, a design system's `tokens.css`) and records a version with its author, unless the content is the one already stored. */
  saveDesignMd(projectId: string, path: string, content: Buffer, author: DesignMdAuthor = { origin: "user" }): void {
    const unchanged = this.readProjectFile(projectId, path)?.equals(content) ?? false;
    const hash = this.setProjectFile(projectId, path, content);
    if (unchanged) return;
    this.db
      .prepare("INSERT INTO design_md_versions (id, project_id, path, hash, created_at, origin, origin_id, origin_label, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), projectId, path, hash, now(), author.origin, author.originId ?? null, author.originLabel ?? null, author.person?.id ?? null);
    if (path === PROJECT_STYLE_PATH && !this.isDesignSystemProject(projectId)) this.announceProjectStyleChange(projectId);
  }

  /** Open pages link the project style through a stylesheet: tell them to reload (`design-system-updated`). */
  announceProjectStyleChange(projectId: string): void {
    const designSystemId = this.sharedDesignSystemIdOfProject(projectId);
    const pageIds = this.listPages(projectId).map((page) => page.id);
    if (pageIds.length > 0) this.emit({ type: "design-system-updated", ...(designSystemId ? { designSystemId } : {}), pageIds });
  }

  /** Versions of DESIGN.md (or of another versioned project-level file, `path`), newest first. */
  listDesignMdVersions(projectId: string, path: string = DESIGN_MD_PATH): DesignMdVersion[] {
    const rows = this.db
      .prepare(
        "SELECT id, hash, created_at, origin, origin_id, origin_label, person_id FROM design_md_versions WHERE project_id = ? AND path = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(projectId, path) as { id: string; hash: string; created_at: string; origin: DesignMdVersion["origin"]; origin_id: string | null; origin_label: string | null; person_id: string | null }[];
    return rows.map((r) => {
      const person = this.getPerson(r.person_id);
      return {
        id: r.id,
        content: readFileSync(join(this.blobDir, r.hash), "utf8"),
        createdAt: r.created_at,
        origin: r.origin,
        ...(r.origin_id ? { originId: r.origin_id } : {}),
        ...(r.origin_label ? { originLabel: r.origin_label } : {}),
        ...(person ? { person } : {}),
      };
    });
  }

  /** A project-level file as UTF-8 text, empty when there is none. */
  readProjectText(projectId: string, path: string): string {
    return this.readProjectFile(projectId, path)?.toString("utf8") ?? "";
  }

  readProjectFile(projectId: string, path: string): Buffer | undefined {
    const row = this.db.prepare("SELECT hash FROM project_files WHERE project_id = ? AND path = ?").get(projectId, path) as
      | { hash: string }
      | undefined;
    return row && readFileSync(join(this.blobDir, row.hash));
  }

  /** Project-level files under `prefix`, as `{name (prefix removed), hash, size}`. */
  listProjectFiles(projectId: string, prefix: string): ProjectAsset[] {
    const rows = this.db
      .prepare("SELECT path, hash FROM project_files WHERE project_id = ? AND substr(path, 1, ?) = ? ORDER BY path")
      .all(projectId, prefix.length, prefix) as { path: string; hash: string }[];
    return rows.map((r) => ({ name: r.path.slice(prefix.length), hash: r.hash, size: statSync(join(this.blobDir, r.hash)).size }));
  }

  createPage(projectId: string, title: string, files: Record<string, string>, createdBy: PageCreator = "user", person?: Person): Page {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO pages (id, project_id, title, created_by, created_at, person_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, projectId, title, createdBy, now(), person?.id ?? null);
    this.createVersion(id, files, "Page created", "creation", person && { person });
    return this.getPage(id)!;
  }

  /** Pages of a project: all of them by default (what the server keeps up to date), or only the active or the archived ones (what people and sessions see). */
  listPages(projectId: string, which: "active" | "archived" | "all" = "all"): Page[] {
    const archived = { active: "AND archived_at IS NULL", archived: "AND archived_at IS NOT NULL", all: "" }[which];
    const ids = this.db
      .prepare(`SELECT id FROM pages WHERE project_id = ? ${archived} ORDER BY ${which === "archived" ? "archived_at DESC," : ""} created_at, rowid`)
      .all(projectId) as { id: string }[];
    return ids.map(({ id }) => this.getPage(id)!);
  }

  /** Pages of regular projects (not design systems), most recently changed first, with the time of their last version. */
  listRecentPages(limit: number): { page: Page; updatedAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, MAX(v.created_at) AS updatedAt FROM pages p JOIN versions v ON v.page_id = p.id
         WHERE p.project_id NOT IN (SELECT project_id FROM design_systems)
           AND p.project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL)
           AND p.archived_at IS NULL
         GROUP BY p.id ORDER BY updatedAt DESC, p.rowid DESC LIMIT ?`,
      )
      .all(limit) as { id: string; updatedAt: string }[];
    return rows.map(({ id, updatedAt }) => ({ page: this.getPage(id)!, updatedAt }));
  }

  renamePage(id: string, title: string): void {
    this.db.prepare("UPDATE pages SET title = ? WHERE id = ?").run(title, id);
    this.emit({ type: "page-renamed", pageId: id });
  }

  getViewSettings(pageId: string): PageViewSettings {
    const row = this.db.prepare("SELECT settings FROM page_view_settings WHERE page_id = ?").get(pageId) as { settings: string } | undefined;
    return row ? { ...EMPTY_VIEW_SETTINGS, ...(JSON.parse(row.settings) as Partial<PageViewSettings>) } : EMPTY_VIEW_SETTINGS;
  }

  setViewSettings(pageId: string, settings: PageViewSettings): PageViewSettings {
    const stored: PageViewSettings = { hiddenFormats: settings.hiddenFormats, renderingOverrides: settings.renderingOverrides, gapExceptions: settings.gapExceptions };
    this.db
      .prepare("INSERT INTO page_view_settings (page_id, settings) VALUES (?, ?) ON CONFLICT(page_id) DO UPDATE SET settings = excluded.settings")
      .run(pageId, JSON.stringify(stored));
    return stored;
  }

  getPage(id: string): Page | undefined {
    const row = this.db
      .prepare("SELECT id, project_id, title, created_by, person_id, archived_at FROM pages WHERE id = ?")
      .get(id) as { id: string; project_id: string; title: string; created_by: PageCreator; person_id: string | null; archived_at: string | null } | undefined;
    if (!row) return undefined;
    const version = this.db
      .prepare("SELECT id, files FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(id) as { id: string; files: string };
    const createdByPerson = this.getPerson(row.person_id);
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      createdBy: row.created_by,
      ...(createdByPerson ? { createdByPerson } : {}),
      version: { id: version.id, files: JSON.parse(version.files) },
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    };
  }

  /** The terminal session that took the page with its last terminal publish, whether it is still present or not. */
  holdOf(pageId: string): { sessionId: string; since: string } | undefined {
    const row = this.db.prepare("SELECT held_by, held_at FROM pages WHERE id = ?").get(pageId) as { held_by: string | null; held_at: string | null } | undefined;
    return row?.held_by && row.held_at ? { sessionId: row.held_by, since: row.held_at } : undefined;
  }

  holdPage(pageId: string, sessionId: string): void {
    this.db.prepare("UPDATE pages SET held_by = ?, held_at = ? WHERE id = ?").run(sessionId, new Date().toISOString(), pageId);
    this.emit({ type: "terminal-hold-changed", pageId });
  }

  /** The held pages with their holder, leaving out the holders in `except`. */
  heldPageIds(except: ReadonlySet<string> = new Set()): { pageId: string; sessionId: string }[] {
    const rows = this.db.prepare("SELECT id, held_by FROM pages WHERE held_by IS NOT NULL").all() as { id: string; held_by: string }[];
    return rows.filter((row) => !except.has(row.held_by)).map((row) => ({ pageId: row.id, sessionId: row.held_by }));
  }

  clearHold(pageId: string): void {
    this.db.prepare("UPDATE pages SET held_by = NULL, held_at = NULL WHERE id = ?").run(pageId);
    this.emit({ type: "terminal-hold-changed", pageId });
  }

  /** True when the page itself is archived (its project may be archived too, see `isArchived`). */
  isPageArchived(pageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM pages WHERE id = ? AND archived_at IS NOT NULL").get(pageId) !== undefined;
  }

  /** Archives (read-only, out of the page lists and of sessions) or unarchives a page. */
  setPageArchived(pageId: string, archived: boolean): void {
    this.db.prepare("UPDATE pages SET archived_at = ? WHERE id = ?").run(archived ? now() : null, pageId);
    const projectId = this.projectIdOfPage(pageId);
    if (projectId) this.emit({ type: "page-archive-changed", pageId, projectId });
  }

  /**
   * Deletes a page for good, with its versions, threads, conversations and view settings; the project's files (assets,
   * DESIGN.md) stay. Returns the blobs its versions referred to, for `collectGarbage`.
   */
  deletePage(pageId: string): string[] {
    const blobs: string[] = [];
    for (const { files } of this.db.prepare("SELECT files FROM versions WHERE page_id = ?").all(pageId) as { files: string }[]) {
      blobs.push(...Object.values(JSON.parse(files) as Record<string, string>));
    }
    this.db.transaction(() => {
      for (const sql of [...pageRowDeletes("?"), "DELETE FROM pages WHERE id = ?"]) {
        this.db.prepare(sql).run(pageId);
      }
    })();
    return blobs;
  }

  /** The element of the page's current manifest carrying `id`; undefined when there is none (or no manifest). */
  canvasElement(pageId: string, id: string): ManifestElement | undefined {
    const manifest = this.getPage(pageId)?.version.files[MANIFEST_PATH];
    if (manifest === undefined) return undefined;
    return parseManifest(this.blobText(manifest)).elements.find((element) => element.id === id);
  }

  /** Whether `file` is an artboard of the page's current version (manifest entry whose file exists; every HTML file without a manifest). */
  hasArtboard(pageId: string, file: string): boolean {
    const page = this.getPage(pageId);
    if (!page || page.version.files[file] === undefined) return false;
    const manifest = page.version.files[MANIFEST_PATH];
    const parsed = manifest === undefined ? defaultManifest(Object.keys(page.version.files)) : parseManifest(this.blobText(manifest));
    return parsed.artboards.some((a) => a.file === file);
  }

  createThread(pageId: string, request: CreateThreadRequest, person?: Person): Thread {
    const id = randomUUID();
    const { next } = this.db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM threads WHERE page_id = ?")
      .get(pageId) as { next: number };
    const title = (request.title?.trim() || request.body.trim().split("\n")[0]).slice(0, 80);
    // artboard and selector are NOT NULL: "" where they do not apply to the target.
    const placement =
      "target" in request
        ? request.target.kind === "artboard"
          ? { kind: "artboard", artboard: request.target.artboard, selector: "", elementName: null, rendering: null, cell: null, xPct: 0, yPct: 0, elementId: null, elementKind: null, elementSummary: null }
          : this.canvasElementPlacement(pageId, request.target.elementId)
        : {
            kind: "element",
            artboard: request.artboard,
            selector: request.selector,
            elementName: request.elementName ?? null,
            rendering: request.rendering ? JSON.stringify({ format: request.rendering.format, width: request.rendering.width }) : null,
            cell: request.cell ? JSON.stringify(request.cell) : null,
            xPct: request.xPct,
            yPct: request.yPct,
            elementId: null,
            elementKind: null,
            elementSummary: null,
          };
    this.db
      .prepare(
        `INSERT INTO threads (id, page_id, number, target_kind, element_id, element_kind, element_summary, artboard, selector, element_name, rendering, cell, x_pct, y_pct, title, body, status, created_at, person_id, via_project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, pageId, next, placement.kind, placement.elementId, placement.elementKind, placement.elementSummary, placement.artboard, placement.selector, placement.elementName, placement.rendering, placement.cell, placement.xPct, placement.yPct, title, request.body, request.held ? "held" : "open", now(), person?.id ?? null, this.viaProjectOf(pageId, request.viaProjectId));
    this.emit({ type: "thread-updated", pageId, threadId: id });
    return this.getThread(id)!;
  }

  private canvasElementPlacement(pageId: string, elementId: string) {
    const element = this.canvasElement(pageId, elementId)!;
    return {
      kind: "canvas-element",
      artboard: "",
      selector: "",
      elementName: null,
      rendering: null,
      cell: null,
      xPct: 0,
      yPct: 0,
      elementId,
      elementKind: element.kind,
      elementSummary: canvasElementSummary(element),
    };
  }

  listThreads(pageId: string): Thread[] {
    const rows = this.db
      .prepare(`${THREAD_SELECT} WHERE page_id = ? ORDER BY number`)
      .all(pageId) as ThreadRow[];
    const elements = this.canvasElementsById(pageId);
    return rows.map((row) => this.withPerson(withCurrentElement(toThread(row, this.repliesOf(row.id)), elements), row.person_id));
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row && this.withPerson(withCurrentElement(toThread(row, this.repliesOf(id)), this.canvasElementsById(row.page_id)), row.person_id);
  }

  private withPerson(thread: Thread, personId: string | null): Thread {
    const person = this.getPerson(personId);
    return person ? { ...thread, person } : thread;
  }

  private canvasElementsById(pageId: string): Map<string, ManifestElement> {
    const manifest = this.getPage(pageId)?.version.files[MANIFEST_PATH];
    const elements = manifest === undefined ? [] : parseManifest(this.blobText(manifest)).elements;
    return new Map(elements.flatMap((element) => (element.id === undefined ? [] : [[element.id, element] as const])));
  }

  /** Held comments of a page, oldest first. */
  listHeldThreads(pageId: string): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.page_id, t.number, t.artboard, t.selector, t.element_name, t.rendering, t.cell, t.target_kind, t.element_id, t.element_kind, t.element_summary, t.x_pct, t.y_pct, t.title, t.body, t.status, t.person_id
         FROM threads t WHERE t.page_id = ? AND t.status = 'held' ORDER BY t.created_at, t.rowid`,
      )
      .all(pageId) as ThreadRow[];
    const elements = this.canvasElementsById(pageId);
    return rows.map((row) => this.withPerson(withCurrentElement(toThread(row, []), elements), row.person_id));
  }

  /** Edits the text of a held comment; undefined when the thread does not exist or is not held. */
  updateHeldThread(id: string, body: string): Thread | undefined {
    const title = body.trim().split("\n")[0].slice(0, 80);
    const { changes } = this.db.prepare("UPDATE threads SET body = ?, title = ? WHERE id = ? AND status = 'held'").run(body, title, id);
    if (changes === 0) return undefined;
    const thread = this.getThread(id)!;
    this.emit({ type: "thread-updated", pageId: thread.pageId, threadId: id });
    return thread;
  }

  /** Deletes a held comment; false when the thread does not exist or is not held. */
  deleteHeldThread(id: string): boolean {
    const thread = this.getThread(id);
    if (!thread || thread.status !== "held") return false;
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    this.emit({ type: "thread-updated", pageId: thread.pageId, threadId: id });
    return true;
  }

  /** A held comment leaves: it becomes a regular open thread. */
  releaseHeldThread(id: string): void {
    this.db.prepare("UPDATE threads SET status = 'open' WHERE id = ? AND status = 'held'").run(id);
    const thread = this.getThread(id);
    if (thread) this.emit({ type: "thread-updated", pageId: thread.pageId, threadId: id });
  }

  resolveThread(id: string): Thread | undefined {
    this.db.prepare("UPDATE threads SET status = 'resolved' WHERE id = ?").run(id);
    const thread = this.getThread(id);
    if (thread) this.emit({ type: "thread-updated", pageId: thread.pageId, threadId: id });
    return thread;
  }

  /** The engine session that opened the thread and the agent that owns it; undefined until a work item was sent. */
  getThreadSession(threadId: string): { sessionId: string; agentId: string } | undefined {
    const row = this.db.prepare("SELECT session_id, agent_id FROM threads WHERE id = ?").get(threadId) as
      | { session_id: string | null; agent_id: string | null }
      | undefined;
    return row?.session_id && row.agent_id ? { sessionId: row.session_id, agentId: row.agent_id } : undefined;
  }

  setThreadSession(threadId: string, sessionId: string, agentId: string): void {
    this.db.prepare("UPDATE threads SET session_id = ?, agent_id = ? WHERE id = ?").run(sessionId, agentId, threadId);
  }

  setThreadContext(threadId: string, context: ThreadContext | null): void {
    this.db.prepare("UPDATE threads SET context = ? WHERE id = ?").run(context && JSON.stringify(context), threadId);
    this.emitThreadUpdated(threadId);
  }

  /** "Nouvelle session" progress: summarizing, ready (the next reply starts `sessionId` seeded with `seed`), or cleared. */
  setNewSession(threadId: string, state: "summarizing" | "ready" | null, seed: string | null = null): void {
    this.db.prepare("UPDATE threads SET new_session = ?, session_seed = ? WHERE id = ?").run(state, seed, threadId);
    this.emitThreadUpdated(threadId);
  }

  getSessionSeed(threadId: string): string | undefined {
    const row = this.db.prepare("SELECT session_seed FROM threads WHERE id = ?").get(threadId) as { session_seed: string | null } | undefined;
    return row?.session_seed ?? undefined;
  }

  private emitThreadUpdated(threadId: string): void {
    const thread = this.getThread(threadId);
    if (thread) this.emit({ type: "thread-updated", pageId: thread.pageId, threadId });
  }

  /** Records an answer of Claude or a message of the user in a thread; undefined if the thread does not exist. */
  addReply(threadId: string, body: string, author: ThreadReply["author"] = "claude", createdPageIds: string[] = [], person?: Person): ThreadReply | undefined {
    const thread = this.getThread(threadId);
    if (!thread) return undefined;
    const reply: ThreadReply = { id: randomUUID(), author, body, createdAt: now() };
    this.db
      .prepare("INSERT INTO thread_replies (id, thread_id, author, body, created_at, created_page_ids, person_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(reply.id, threadId, reply.author, body, reply.createdAt, createdPageIds.length > 0 ? JSON.stringify(createdPageIds) : null, person?.id ?? null);
    this.emit({ type: "thread-updated", pageId: thread.pageId, threadId });
    return this.repliesOf(threadId).find((r) => r.id === reply.id);
  }

  /** Remembers that the run `workId` created the page with `create_page`. */
  recordCreatedPage(workId: string, pageId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO run_created_pages (work_id, page_id) VALUES (?, ?)").run(workId, pageId);
  }

  /** Ids of the pages the run created that no answer carries yet; they are marked as carried, so only the first answer of a run shows them. */
  takeCreatedPages(workId: string): string[] {
    const rows = this.db
      .prepare("SELECT page_id FROM run_created_pages WHERE work_id = ? AND attached = 0 ORDER BY rowid")
      .all(workId) as { page_id: string }[];
    this.db.prepare("UPDATE run_created_pages SET attached = 1 WHERE work_id = ?").run(workId);
    return rows.map((r) => r.page_id);
  }

  /** Created pages as shown under an answer: current name and artboard count. */
  private createdPagesOf(json: string | null): CreatedPage[] | undefined {
    if (!json) return undefined;
    const pages: CreatedPage[] = [];
    for (const id of JSON.parse(json) as string[]) {
      const page = this.getPage(id);
      if (!page) continue;
      const manifest = page.version.files[MANIFEST_PATH];
      const parsed = manifest === undefined ? defaultManifest(Object.keys(page.version.files)) : parseManifest(this.blobText(manifest));
      pages.push({ pageId: page.id, name: page.title, artboardCount: parsed.artboards.length });
    }
    return pages.length > 0 ? pages : undefined;
  }

  blobText(hash: string): string {
    return readFileSync(join(this.blobDir, hash), "utf8");
  }

  createConversation(pageId: string, title: string, person?: Person, viaProjectId?: string): Conversation {
    const createdAt = now();
    const conversation: Conversation = { id: randomUUID(), pageId, title, archived: false, createdAt, ...(person ? { startedBy: person } : {}), exchangeCount: 0, lastActivityAt: createdAt };
    this.db
      .prepare("INSERT INTO conversations (id, page_id, title, created_at, person_id, via_project_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(conversation.id, pageId, title, conversation.createdAt, person?.id ?? null, this.viaProjectOf(pageId, viaProjectId));
    this.emit({ type: "conversation-updated", pageId, conversationId: conversation.id });
    return conversation;
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare(`${CONVERSATION_SELECT} WHERE id = ?`).get(id) as ConversationRow | undefined;
    return row && this.toConversation(row);
  }

  /** Conversations of a page, oldest first (archived ones included). */
  listConversations(pageId: string): Conversation[] {
    const rows = this.db.prepare(`${CONVERSATION_SELECT} WHERE page_id = ? ORDER BY created_at, rowid`).all(pageId) as ConversationRow[];
    return rows.map((row) => this.toConversation(row));
  }

  private toConversation({ personId, ...row }: ConversationRow): Conversation {
    const startedBy = this.getPerson(personId);
    return { ...row, archived: row.archived === 1, ...(startedBy ? { startedBy } : {}) };
  }

  /** True once any page of the project has a conversation. */
  projectHasConversation(projectId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM conversations c JOIN pages p ON p.id = c.page_id WHERE p.project_id = ? LIMIT 1")
        .get(projectId) !== undefined
    );
  }

  archiveConversation(id: string): Conversation | undefined {
    this.db.prepare("UPDATE conversations SET archived = 1 WHERE id = ?").run(id);
    const conversation = this.getConversation(id);
    if (conversation) this.emit({ type: "conversation-updated", pageId: conversation.pageId, conversationId: id });
    return conversation;
  }

  /** The engine session of the conversation and the agent that owns it; undefined until a first message was sent. */
  getConversationSession(id: string): { sessionId: string; agentId: string } | undefined {
    const row = this.db.prepare("SELECT session_id, agent_id FROM conversations WHERE id = ?").get(id) as
      | { session_id: string | null; agent_id: string | null }
      | undefined;
    return row?.session_id && row.agent_id ? { sessionId: row.session_id, agentId: row.agent_id } : undefined;
  }

  setConversationSession(id: string, sessionId: string, agentId: string): void {
    this.db.prepare("UPDATE conversations SET session_id = ?, agent_id = ? WHERE id = ?").run(sessionId, agentId, id);
  }

  getConversationContext(id: string): ThreadContext | undefined {
    const row = this.db.prepare("SELECT context FROM conversations WHERE id = ?").get(id) as { context: string | null } | undefined;
    return row?.context ? (JSON.parse(row.context) as ThreadContext) : undefined;
  }

  setConversationContext(id: string, context: ThreadContext): void {
    this.db.prepare("UPDATE conversations SET context = ? WHERE id = ?").run(JSON.stringify(context), id);
    const conversation = this.getConversation(id);
    if (conversation) this.emit({ type: "conversation-updated", pageId: conversation.pageId, conversationId: id });
  }

  addConversationMessage(
    conversationId: string,
    author: ConversationMessage["author"],
    body: string,
    choice: ModelChoice = {},
    createdPageIds: string[] = [],
    targets: ThreadTarget[] = [],
    person?: Person,
  ): ConversationMessage | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const message: ConversationMessage = { id: randomUUID(), author, body, ...choice, createdAt: now() };
    this.db
      .prepare("INSERT INTO conversation_messages (id, conversation_id, author, body, model, effort, created_at, created_page_ids, targets, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        message.id,
        conversationId,
        author,
        body,
        choice.model ?? null,
        choice.effort ?? null,
        message.createdAt,
        createdPageIds.length > 0 ? JSON.stringify(createdPageIds) : null,
        targets.length > 0 ? JSON.stringify(targets) : null,
        person?.id ?? null,
      );
    this.emit({ type: "conversation-updated", pageId: conversation.pageId, conversationId });
    return this.conversationMessages(conversationId).find((m) => m.id === message.id);
  }

  conversationMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(
        "SELECT id, author, body, model, effort, created_at AS createdAt, created_page_ids AS createdPageIds, targets, person_id AS personId FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      )
      .all(conversationId) as (ConversationMessage & { model: string | null; effort: Effort | null; createdPageIds: string | null; targets: string | null; personId: string | null })[];
    return rows.map(({ model, effort, createdPageIds, targets, personId, ...rest }) => {
      const createdPages = this.createdPagesOf(createdPageIds);
      const person = this.getPerson(personId);
      return { ...rest, ...(person ? { person } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(createdPages ? { createdPages } : {}), ...(targets ? { targets: JSON.parse(targets) as ThreadTarget[] } : {}) };
    });
  }

  private repliesOf(threadId: string): ThreadReply[] {
    const rows = this.db
      .prepare("SELECT id, author, body, created_at AS createdAt, created_page_ids AS createdPageIds, person_id AS personId FROM thread_replies WHERE thread_id = ? ORDER BY created_at, rowid")
      .all(threadId) as (ThreadReply & { createdPageIds: string | null; personId: string | null })[];
    return rows.map(({ createdPageIds, personId, ...reply }) => {
      const createdPages = this.createdPagesOf(createdPageIds);
      const person = this.getPerson(personId);
      return { ...reply, ...(person ? { person } : {}), ...(createdPages ? { createdPages } : {}) };
    });
  }

  /** Every file of the page's current version as UTF-8 text, or undefined if the page is unknown. */
  readPageFiles(pageId: string): { versionId: string; files: Record<string, string> } | undefined {
    const version = this.getPage(pageId)?.version;
    if (!version) return undefined;
    const files: Record<string, string> = {};
    for (const [path, hash] of Object.entries(version.files)) {
      files[path] = readFileSync(join(this.blobDir, hash), "utf8");
    }
    return { versionId: version.id, files };
  }

  /** Every file of one version of a page as UTF-8 text, or undefined if the version is unknown. */
  readVersionFiles(pageId: string, versionId: string): Record<string, string> | undefined {
    const row = this.db.prepare("SELECT files FROM versions WHERE id = ? AND page_id = ?").get(versionId, pageId) as { files: string } | undefined;
    if (!row) return undefined;
    const files: Record<string, string> = {};
    for (const [path, hash] of Object.entries(JSON.parse(row.files) as Record<string, string>)) {
      files[path] = readFileSync(join(this.blobDir, hash), "utf8");
    }
    return files;
  }

  /** Reads a file of the page's current version, or undefined if the page or path is unknown. */
  readPageFile(pageId: string, path: string): Buffer | undefined {
    const hash = this.getPage(pageId)?.version.files[path];
    return hash === undefined ? undefined : readFileSync(join(this.blobDir, hash));
  }

  /** Records a new version of the page from file contents. */
  addVersion(pageId: string, files: Record<string, string>, message: string, origin: VersionOrigin, ref?: OriginRef): PageVersionSummary {
    const designSystem = this.designSystemOfPage(pageId);
    const { [DESIGN_SYSTEM_TOKENS_PATH]: tokens, ...pageFiles } = files;
    if (!designSystem || tokens === undefined) return this.createVersion(pageId, files, message, origin, ref);
    // A design system's tokens belong to the design system, not to the page they were published from.
    const author: DesignMdAuthor = {
      origin: origin === "thread" || origin === "conversation" || origin === "terminal" ? origin : "user",
      ...(ref?.originId ? { originId: ref.originId } : {}),
      ...(ref?.originLabel ? { originLabel: ref.originLabel } : {}),
      ...(ref?.person ? { person: ref.person } : {}),
    };
    this.saveDesignMd(designSystem.id, DESIGN_SYSTEM_TOKENS_PATH, Buffer.from(tokens, "utf8"), author);
    return this.createVersion(pageId, pageFiles, message, origin, ref);
  }

  /** Records a version whose files are given as path -> blob hash (hashes of this store). */
  addVersionFromHashes(pageId: string, hashes: Record<string, string>, message: string, origin: VersionOrigin, ref?: OriginRef): PageVersionSummary {
    return this.insertVersion(pageId, JSON.stringify(hashes), message, origin, ref);
  }

  /** Stores UTF-8 text as a blob and returns its hash. */
  putText(content: string): string {
    return this.putBlob(Buffer.from(content, "utf8"));
  }

  /** Every version of a page with its file hashes, OLDEST first. */
  listVersionRecords(pageId: string): VersionRecord[] {
    const rows = this.db
      .prepare("SELECT id, files, message, origin, origin_id, origin_label, person_id, created_at, diffusion FROM versions WHERE page_id = ? ORDER BY created_at, rowid")
      .all(pageId) as (VersionRow & { files: string; diffusion: number | null })[];
    return rows.map((row) => ({ ...this.toSummary(row), files: JSON.parse(row.files) as Record<string, string>, diffusion: row.diffusion ?? 1 }));
  }

  /** One file of one version of a page, or undefined if either is unknown. */
  readVersionFile(pageId: string, versionId: string, path: string): Buffer | undefined {
    const row = this.db.prepare("SELECT files FROM versions WHERE id = ? AND page_id = ?").get(versionId, pageId) as { files: string } | undefined;
    const hash = row && (JSON.parse(row.files) as Record<string, string>)[path];
    return hash ? readFileSync(join(this.blobDir, hash)) : undefined;
  }

  /** Records a new version identical to the current one except for one file. */
  setPageFile(pageId: string, path: string, content: string, message: string, origin: VersionOrigin, ref?: OriginRef): PageVersionSummary {
    const hashes = { ...this.getPage(pageId)!.version.files, [path]: this.putBlob(Buffer.from(content, "utf8")) };
    return this.insertVersion(pageId, JSON.stringify(hashes), message, origin, ref);
  }

  /** Sets the height of one artboard's manifest entry (writing a manifest when the page had none), as one version. The caller checked the request. */
  setArtboardHeight(pageId: string, file: string, height: number, message: string, origin: VersionOrigin, ref?: OriginRef): PageVersionSummary {
    const hash = this.getPage(pageId)!.version.files[MANIFEST_PATH];
    const manifest = hash === undefined ? (defaultManifest(Object.keys(this.getPage(pageId)!.version.files)) as unknown as RawManifest) : (JSON.parse(this.blobText(hash)) as RawManifest);
    const artboards = (manifest.artboards ?? []).map((artboard) => (artboard.file === file ? { ...artboard, height } : artboard));
    return this.setPageFile(pageId, MANIFEST_PATH, JSON.stringify({ ...manifest, artboards }, null, 2), message, origin, ref);
  }

  /**
   * Moves an artboard (file, manifest entry, threads) from `sourceId` to another page of the same project, or to a page
   * created here, in one transaction: the artboard is on both pages or on neither at no moment. The caller checked the
   * request (see `move-artboard.ts`). The artboard lands right of the target's artboards, same size.
   */
  moveArtboard(
    sourceId: string,
    file: string,
    target: { pageId: string } | { newPageTitle: string },
    origin: VersionOrigin,
    ref?: OriginRef,
  ): { targetPage: Page; sourceVersion: PageVersionSummary; targetVersion: PageVersionSummary } {
    const movedThreadIds: string[] = [];
    const result = this.db.transaction(() => {
      const source = this.getPage(sourceId)!;
      const targetPage = "pageId" in target ? this.getPage(target.pageId)! : this.createPage(source.projectId, target.newPageTitle, starterPageFiles(this.getProject(source.projectId)?.designSystem));
      const sourceFiles = { ...source.version.files };
      const targetFiles = { ...targetPage.version.files };
      const rawManifest = (page: Page) => {
        const hash = page.version.files[MANIFEST_PATH];
        return hash === undefined ? (defaultManifest(Object.keys(page.version.files)) as unknown as RawManifest) : (JSON.parse(this.blobText(hash)) as RawManifest);
      };
      const sourceManifest = rawManifest(source);
      const targetManifest = rawManifest(targetPage);
      const entry = (sourceManifest.artboards ?? []).find((a) => a.file === file)!;
      const placed = parseManifest(JSON.stringify(targetManifest)).artboards;
      const x = placed.length === 0 ? 0 : Math.max(...placed.map((a) => a.x + a.width)) + ARTBOARD_GAP;
      const y = placed.length === 0 ? 0 : Math.min(...placed.map((a) => a.y));

      targetFiles[file] = sourceFiles[file];
      delete sourceFiles[file];
      targetManifest.artboards = [...(targetManifest.artboards ?? []), { ...entry, x, y }];
      targetFiles[MANIFEST_PATH] = this.putText(JSON.stringify(targetManifest, null, 2));
      if (source.version.files[MANIFEST_PATH] !== undefined) {
        sourceFiles[MANIFEST_PATH] = this.putText(JSON.stringify(manifestWithoutArtboard(sourceManifest, file), null, 2));
      }

      const threadIds = this.db.prepare("SELECT id FROM threads WHERE page_id = ? AND artboard = ? ORDER BY number").all(sourceId, file) as { id: string }[];
      let { next } = this.db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM threads WHERE page_id = ?").get(targetPage.id) as { next: number };
      for (const { id } of threadIds) {
        this.db.prepare("UPDATE threads SET page_id = ?, number = ? WHERE id = ?").run(targetPage.id, next++, id);
        movedThreadIds.push(id);
      }

      const sourceVersion = this.insertVersion(sourceId, JSON.stringify(sourceFiles), `${file} déplacé vers ${targetPage.title}`, origin, ref);
      const targetVersion = this.insertVersion(targetPage.id, JSON.stringify(targetFiles), `${file} reçu de ${source.title}`, origin, ref);
      return { targetPage, sourceVersion, targetVersion };
    })();
    for (const threadId of movedThreadIds) {
      this.emit({ type: "thread-updated", pageId: sourceId, threadId });
      this.emit({ type: "thread-updated", pageId: result.targetPage.id, threadId });
    }
    return { ...result, targetPage: this.getPage(result.targetPage.id)! };
  }

  /** Versions of a page, newest first. */
  listVersions(pageId: string): PageVersionSummary[] {
    const rows = this.db
      .prepare(
        "SELECT id, message, origin, origin_id, origin_label, person_id, created_at FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(pageId) as VersionRow[];
    return rows.map((row) => this.toSummary(row));
  }

  /** Repoints the page's paths to the hashes of an old version and records that as a new version. */
  restoreVersion(pageId: string, versionId: string, ref?: OriginRef, timeZone?: string): PageVersionSummary | undefined {
    const old = this.db
      .prepare("SELECT files, created_at FROM versions WHERE id = ? AND page_id = ?")
      .get(versionId, pageId) as { files: string; created_at: string } | undefined;
    if (!old) return undefined;
    return this.insertVersion(pageId, old.files, restoredVersionMessage(old.created_at, timeZone), "restore", ref);
  }

  private createVersion(
    pageId: string,
    files: Record<string, string>,
    message: string,
    origin: VersionOrigin,
    ref?: OriginRef,
  ): PageVersionSummary {
    const hashes: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      hashes[path] = this.putBlob(Buffer.from(content, "utf8"));
    }
    return this.insertVersion(pageId, JSON.stringify(hashes), message, origin, ref);
  }

  private insertVersion(pageId: string, filesJson: string, message: string, origin: VersionOrigin, ref?: OriginRef): PageVersionSummary {
    const row: VersionRow = { id: randomUUID(), message, origin, origin_id: ref?.originId ?? null, origin_label: ref?.originLabel ?? null, person_id: ref?.person?.id ?? null, created_at: now() };
    this.db
      .prepare("INSERT INTO versions (id, page_id, files, created_at, message, origin, origin_id, origin_label, person_id, diffusion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, pageId, filesJson, row.created_at, message, origin, row.origin_id, row.origin_label, row.person_id, this.diffusionForNewVersion(pageId, filesJson) ?? null);
    this.emit({ type: "page-updated", pageId, versionId: row.id });
    return this.toSummary(row);
  }

  private toSummary(row: VersionRow): PageVersionSummary {
    const person = this.getPerson(row.person_id);
    return {
      id: row.id,
      message: row.message,
      origin: row.origin,
      ...(row.origin_id ? { originId: row.origin_id } : {}),
      ...(row.origin_label ? { originLabel: row.origin_label } : {}),
      ...(person ? { person } : {}),
      createdAt: row.created_at,
    };
  }

  /** The diffusion a version recorded now is drawn with: the current one of the design system its manifest names; none for a design system's own pages (they read the draft). */
  private diffusionForNewVersion(pageId: string, filesJson: string): number | undefined {
    if (this.isDesignSystemPage(pageId)) return undefined;
    const manifestHash = (JSON.parse(filesJson) as Record<string, string>)[MANIFEST_PATH];
    const designSystemId = this.sharedDesignSystemIdForManifest(pageId, manifestHash === undefined ? undefined : this.blobText(manifestHash));
    return designSystemId === undefined ? undefined : this.currentDiffusion(designSystemId)?.number;
  }

  /**
   * THE rule for the shared design system of a page: a design system's own page is its own system; else the one its
   * manifest names if it exists (Neutral never counts); else the project's, if set (Neutral never counts); else none.
   * `manifestText` is the manifest of the page version at hand.
   */
  sharedDesignSystemIdForManifest(pageId: string, manifestText: string | undefined): string | undefined {
    const own = this.designSystemOfPage(pageId);
    if (own) return own.id;
    if (manifestText !== undefined) {
      try {
        const id = parseManifest(manifestText).designSystem;
        if (id !== undefined && id !== NEUTRAL_DESIGN_SYSTEM_ID && this.getDesignSystem(id)) return id;
      } catch {
        // An invalid stored manifest must not break serving the artboard.
      }
    }
    // Not getPage: a page's first version is recorded before it has one to read.
    const row = this.db.prepare("SELECT project_id AS projectId FROM pages WHERE id = ?").get(pageId) as { projectId: string } | undefined;
    return row && this.sharedDesignSystemIdOfProject(row.projectId);
  }

  /** The shared design system of a page as of its current version, or of `versionId` when given. */
  sharedDesignSystemIdOfPage(pageId: string, versionId?: string): string | undefined {
    const manifest = versionId === undefined ? this.readPageFile(pageId, MANIFEST_PATH) : this.readVersionFile(pageId, versionId, MANIFEST_PATH);
    return this.sharedDesignSystemIdForManifest(pageId, manifest?.toString("utf8"));
  }

  /** The shared design system a project follows: none when it has none or the hidden Neutral one. */
  sharedDesignSystemIdOfProject(projectId: string): string | undefined {
    const id = this.getProject(projectId)?.designSystem;
    return id && id !== NEUTRAL_DESIGN_SYSTEM_ID ? id : undefined;
  }

  /** Diffusion a version is drawn with: the one recorded when it was published, 1 for versions from before diffusions; none for a design system's own pages. */
  versionDiffusion(pageId: string, versionId: string): number | undefined {
    if (this.isDesignSystemPage(pageId)) return undefined;
    const row = this.db.prepare("SELECT diffusion FROM versions WHERE id = ? AND page_id = ?").get(versionId, pageId) as { diffusion: number | null } | undefined;
    return row === undefined ? undefined : (row.diffusion ?? 1);
  }

  private putBlob(content: Buffer): string {
    const hash = createHash("sha256").update(content).digest("hex");
    const blobPath = join(this.blobDir, hash);
    if (!existsSync(blobPath)) writeFileSync(blobPath, content);
    else {
      // Reused: marked fresh, so that a garbage collection running meanwhile leaves it to the request about to refer to it.
      const nowDate = new Date();
      try {
        utimesSync(blobPath, nowDate, nowDate);
      } catch {
        // Read-only data folder: the blob is still there.
      }
    }
    return hash;
  }
}

/** A work item as the page lock keeps it between restarts. */
export interface PersistedWork {
  /** "active" ran on an agent when the server stopped; "retrying" waits for `retryAt`; "failed" waits for the user's "Relancer". */
  state: "active" | "queued" | "retrying" | "failed";
  projectId: string;
  agentId?: string;
  item: WorkItem;
  takeoverItem?: WorkItem;
  attempts: number;
  retryAt?: string;
  limit?: boolean;
  message?: string;
}

export interface SessionOrigin {
  id: string;
  kind: SessionKind;
  pageId: string;
  pageTitle: string;
  projectId: string;
  projectTitle: string;
  createdAt: string;
}

/** Blobs younger than this are left by a garbage collection: a request may have stored one and not recorded it yet. */
export const BLOB_MIN_AGE_MS = 600_000;

/**
 * The rows that belong to the pages `pages` selects (one `?` parameter: a page id, or a subquery on a project id), deleted
 * before the pages themselves: a new table that refers to pages must be listed here.
 */
const pageRowDeletes = (pages: string) => [
  `DELETE FROM thread_replies WHERE thread_id IN (SELECT id FROM threads WHERE page_id IN (${pages}))`,
  `DELETE FROM threads WHERE page_id IN (${pages})`,
  `DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE page_id IN (${pages}))`,
  `DELETE FROM conversations WHERE page_id IN (${pages})`,
  `DELETE FROM page_view_settings WHERE page_id IN (${pages})`,
  `DELETE FROM run_created_pages WHERE page_id IN (${pages})`,
  `DELETE FROM versions WHERE page_id IN (${pages})`,
];

/**
 * Every column holding a blob hash, besides `versions.files` (a JSON map of path -> hash). A new column that stores a
 * blob hash must be listed here, or deleting a project would remove blobs it still needs. `owner` is its project column.
 */
const BLOB_HASH_COLUMNS = [
  { table: "project_files", column: "hash", owner: "project_id" },
  { table: "design_md_versions", column: "hash", owner: "project_id" },
  ...["tokens_hash", "components_hash", "design_md_hash", "component_list_hash", "index_hash", "component_files_hash"].map((column) => ({
    table: "design_system_diffusions",
    column,
    owner: "design_system_id",
  })),
] as const;

interface DesignSystemRow {
  id: string;
  title: string;
  pageId: string;
  archivedAt: string | null;
}

function toDesignSystem({ archivedAt, ...designSystem }: DesignSystemRow): DesignSystem {
  return { ...designSystem, ...(archivedAt ? { archivedAt } : {}) };
}

const PROJECT_SELECT = "SELECT id, title, instructions, design_system AS designSystem FROM projects";

const THREAD_SELECT =
  "SELECT id, page_id, number, artboard, selector, element_name, rendering, cell, target_kind, element_id, element_kind, element_summary, x_pct, y_pct, title, body, status, context, new_session, person_id FROM threads";

interface ThreadRow {
  id: string;
  page_id: string;
  number: number;
  artboard: string;
  selector: string;
  element_name: string | null;
  rendering: string | null;
  cell: string | null;
  target_kind: ThreadTarget["kind"];
  element_id: string | null;
  element_kind: ManifestElementKind | null;
  element_summary: string | null;
  x_pct: number;
  y_pct: number;
  title: string;
  body: string;
  status: ThreadStatus;
  context: string | null;
  new_session: "summarizing" | "ready" | null;
  person_id: string | null;
}

function targetOf(row: ThreadRow): ThreadTarget {
  if (row.target_kind === "artboard") return { kind: "artboard", artboard: row.artboard };
  if (row.target_kind === "canvas-element") return {
      kind: "canvas-element",
      elementId: row.element_id!,
      elementKind: row.element_kind!,
      ...(row.element_summary ? { elementSummary: row.element_summary } : {}),
    };
  return {
    kind: "element",
    artboard: row.artboard,
    selector: row.selector,
    elementName: row.element_name,
    xPct: row.x_pct,
    yPct: row.y_pct,
    ...(row.rendering ? { rendering: JSON.parse(row.rendering) as ThreadRendering } : {}),
    ...(row.cell ? { cell: JSON.parse(row.cell) as TweakValues } : {}),
  };
}

/** A canvas-element thread follows its element: kind and summary of the current manifest, or `removed` (with what it showed) when the element is gone. */
function withCurrentElement(thread: Thread, elements: Map<string, ManifestElement>): Thread {
  if (thread.target.kind !== "canvas-element") return thread;
  const element = elements.get(thread.target.elementId);
  if (!element) return { ...thread, removed: true };
  const { elementSummary: _stored, ...target } = thread.target;
  const elementSummary = canvasElementSummary(element);
  return { ...thread, target: { ...target, elementKind: element.kind, ...(elementSummary ? { elementSummary } : {}) } };
}

function toThread(row: ThreadRow, replies: ThreadReply[]): Thread {
  return {
    id: row.id,
    pageId: row.page_id,
    number: row.number,
    target: targetOf(row),
    artboard: row.artboard,
    selector: row.selector,
    elementName: row.element_name,
    ...(row.rendering ? { rendering: JSON.parse(row.rendering) as ThreadRendering } : {}),
    ...(row.cell ? { cell: JSON.parse(row.cell) as TweakValues } : {}),
    xPct: row.x_pct,
    yPct: row.y_pct,
    title: row.title,
    body: row.body,
    status: row.status,
    replies,
    ...(row.context ? { context: JSON.parse(row.context) as ThreadContext } : {}),
    ...(row.new_session ? { newSession: row.new_session } : {}),
  };
}

const CONVERSATION_SELECT = `SELECT id, page_id AS pageId, title, archived, created_at AS createdAt, person_id AS personId,
  (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = conversations.id AND m.author = 'user') AS exchangeCount,
  COALESCE((SELECT MAX(m.created_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id), created_at) AS lastActivityAt
  FROM conversations`;

interface ConversationRow extends Omit<Conversation, "archived" | "startedBy"> {
  archived: number;
  personId: string | null;
}

interface VersionRow {
  id: string;
  message: string;
  origin: VersionOrigin;
  origin_id?: string | null;
  origin_label?: string | null;
  person_id?: string | null;
  created_at: string;
}

/** The thread or conversation a version comes from. */
/** A stored manifest as JSON, so a move keeps every field it does not know. */
interface RawManifest {
  artboards?: ({ file: string } & Record<string, unknown>)[];
  elements?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface OriginRef {
  originId?: string;
  originLabel?: string;
  /** Who the version is signed with: the person acting, or the requesting person of a Claude run; none for terminal publishes. */
  person?: Person;
}

export interface VersionRecord extends PageVersionSummary {
  /** Path -> blob hash. */
  files: Record<string, string>;
  /** Diffusion recorded with the version (1 for versions from before diffusions); meaningless on a design system's own pages. */
  diffusion: number;
}

function now(): string {
  return new Date().toISOString();
}
