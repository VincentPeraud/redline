import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { componentFilesOf, projectComponents } from "./components.js";
import {
  EMPTY_VIEW_SETTINGS,
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
  type ProjectStyleStart,
  PROJECT_STYLE_PATH,
  NEUTRAL_TOKENS_PAGE_HTML,
  type DesignSystem,
  type DesignMdAuthor,
  type DesignMdVersion,
  type ProjectAsset,
} from "@redline/shared";
import type {
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
  AgentInfo,
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
  ServerEvent,
  SessionKind,
  Thread,
  ThreadContext,
  ThreadReply,
  ThreadStatus,
  VersionOrigin,
  WorkItem,
} from "@redline/shared";

export class Store {
  private readonly db: Database.Database;
  private readonly blobDir: string;
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  constructor(dataDir: string) {
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, "redline.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
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
      UPDATE agents SET status = 'offline';
    `);
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!agentColumns.some((c) => c.name === "project_id")) this.db.exec("ALTER TABLE agents ADD COLUMN project_id TEXT");
    if (!agentColumns.some((c) => c.name === "model")) this.db.exec("ALTER TABLE agents ADD COLUMN model TEXT");
    if (!agentColumns.some((c) => c.name === "effort")) this.db.exec("ALTER TABLE agents ADD COLUMN effort TEXT");
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
    // The old per-project boolean (default 0) becomes a nullable override of the global setting: only an explicit "allow" is kept.
    if (!columnsOf("projects").includes("takeover_override")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN takeover_override INTEGER");
      if (columnsOf("projects").includes("allow_global_takeover")) {
        this.db.exec("UPDATE projects SET takeover_override = 1 WHERE allow_global_takeover = 1");
      }
    }
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
    return this.db
      .prepare(
        "SELECT p.id, p.title, d.page_id AS pageId FROM design_systems d JOIN projects p ON p.id = d.project_id WHERE p.id = ?",
      )
      .get(id) as DesignSystem | undefined;
  }

  listDesignSystems(): DesignSystem[] {
    return this.db
      .prepare(
        "SELECT p.id, p.title, d.page_id AS pageId FROM design_systems d JOIN projects p ON p.id = d.project_id ORDER BY p.created_at, p.rowid",
      )
      .all() as DesignSystem[];
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
    const row = this.db.prepare("SELECT id FROM agents WHERE project_id = ?").get(projectId) as { id: string } | undefined;
    return row?.id;
  }

  /** True while the agent is linked to a project; a project agent replaced by a newer one, and a global agent, are not. */
  isProjectAgent(agentId: string): boolean {
    return this.db.prepare("SELECT 1 FROM agents WHERE id = ? AND project_id IS NOT NULL").get(agentId) !== undefined;
  }

  /** Projects (design systems excluded) whose design system is `designSystemId`. */
  projectsUsingDesignSystem(designSystemId: string): { id: string; title: string }[] {
    return this.db
      .prepare(
        "SELECT id, title FROM projects WHERE design_system = ? AND id NOT IN (SELECT project_id FROM design_systems) ORDER BY created_at, rowid",
      )
      .all(designSystemId) as { id: string; title: string }[];
  }

  /** The design system a page belongs to (one of its own pages), if any. */
  designSystemOfPage(pageId: string): DesignSystem | undefined {
    return this.db
      .prepare(
        `SELECT p.id, p.title, d.page_id AS pageId FROM pages pg JOIN design_systems d ON d.project_id = pg.project_id
         JOIN projects p ON p.id = d.project_id WHERE pg.id = ?`,
      )
      .get(pageId) as DesignSystem | undefined;
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

  /** Calls `listener` after every change the web UI shows (new thread or reply, new version). Returns the unsubscribe function. */
  onChange(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Id of the online project agent serving the project. */
  findOnlineProjectAgentId(projectId: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM agents WHERE project_id = ? AND status = 'online'").get(projectId) as
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
  markAgentOnline(machine: string, folder: string, kind: AgentKind, projectId?: string, model?: string, effort?: Effort): string {
    if (projectId) this.db.prepare("UPDATE agents SET project_id = NULL WHERE project_id = ?").run(projectId);
    this.db
      .prepare(
        `INSERT INTO agents (id, machine, folder, kind, status, last_seen_at, project_id, model, effort) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
         ON CONFLICT(machine, folder) DO UPDATE SET kind = excluded.kind, status = 'online', last_seen_at = excluded.last_seen_at, project_id = excluded.project_id, model = excluded.model, effort = excluded.effort`,
      )
      .run(randomUUID(), machine, folder, kind, now(), projectId ?? null, model ?? null, effort ?? null);
    return (this.db.prepare("SELECT id FROM agents WHERE machine = ? AND folder = ?").get(machine, folder) as { id: string }).id;
  }

  markAgentOffline(id: string): void {
    this.db.prepare("UPDATE agents SET status = 'offline', last_seen_at = ? WHERE id = ?").run(now(), id);
  }

  /** The online project agent serving a project, other than the given machine and folder. */
  findOtherOnlineProjectAgent(projectId: string, machine: string, folder: string): { machine: string; folder: string } | undefined {
    return this.db
      .prepare(
        "SELECT machine, folder FROM agents WHERE project_id = ? AND status = 'online' AND NOT (machine = ? AND folder = ?)",
      )
      .get(projectId, machine, folder) as { machine: string; folder: string } | undefined;
  }

  listAgents(): AgentInfo[] {
    const rows = this.db
      .prepare("SELECT id, machine, folder, kind, status, last_seen_at AS lastSeenAt, model, effort FROM agents ORDER BY machine, folder")
      .all() as (Omit<AgentInfo, "model" | "effort"> & { model: string | null; effort: Effort | null })[];
    return rows.map(({ model, effort, ...agent }) => ({ ...agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
  }

  private insertProject(title: string, id: string, instructions: string, designSystem: string | null): Project {
    this.db
      .prepare("INSERT INTO projects (id, title, instructions, design_system, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, title, instructions, designSystem, now());
    return { id, title, instructions, designSystem, globalTakeover: this.getGlobalTakeover(), globalTakeoverOverride: null };
  }

  /** A project without a shared design system starts with the neutral values as its project style. */
  createProject(title: string, id: string = randomUUID(), instructions = "", designSystem: string | null = null): Project {
    const project = this.insertProject(title, id, instructions, designSystem);
    if (designSystem === null) this.saveDesignMd(id, PROJECT_STYLE_PATH, Buffer.from(NEUTRAL_TOKENS_CSS, "utf8"));
    return project;
  }

  /**
   * Points a project at a shared design system, or at none (null: its project style becomes its whole style). Pages follow the
   * `designSystem` of their manifest, so each page whose manifest says otherwise gets a version with the new value.
   */
  setProjectDesignSystem(projectId: string, designSystem: string | null, origin: VersionOrigin, startFrom?: ProjectStyleStart): void {
    const previous = this.getProject(projectId)!.designSystem;
    if (designSystem === null && previous !== null && startFrom) {
      this.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(this.startingStyle(projectId, previous, startFrom), "utf8"));
    }
    this.db.prepare("UPDATE projects SET design_system = ? WHERE id = ?").run(designSystem, projectId);
    if (designSystem === null && !this.readProjectFile(projectId, PROJECT_STYLE_PATH)) {
      this.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(NEUTRAL_TOKENS_CSS, "utf8"));
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
      this.addVersion(page.id, { ...files, [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n` }, designSystem === null ? "No shared design system" : "Design system changed", origin);
    }
  }

  /** The project style after leaving `fromDesignSystem`: the base values (its current diffusion, or neutral) with the project's overrides on top. */
  private startingStyle(projectId: string, fromDesignSystem: string, startFrom: ProjectStyleStart): string {
    const diffusion = this.currentDiffusion(fromDesignSystem);
    const base = startFrom === "design-system" && diffusion ? (this.readDiffusionFile(fromDesignSystem, diffusion.number, "tokens.css") ?? NEUTRAL_TOKENS_CSS) : NEUTRAL_TOKENS_CSS;
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

  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.instructions, p.design_system AS designSystem, p.takeover_override AS takeoverOverride, a.id AS agentId, a.machine, a.folder, a.status
         FROM projects p LEFT JOIN agents a ON a.project_id = p.id
         WHERE p.id NOT IN (SELECT project_id FROM design_systems)
         ORDER BY p.created_at, p.rowid`,
      )
      .all() as {
      id: string;
      title: string;
      instructions: string;
      designSystem: string | null;
      takeoverOverride: number | null;
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
    }));
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((p) => p.id === id);
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

  /** True once a project agent has been linked to the project, online or not. */
  hasProjectAgent(projectId: string): boolean {
    return this.db.prepare("SELECT 1 FROM agents WHERE project_id = ?").get(projectId) !== undefined;
  }

  /** Id of an online global agent, the most recently seen first. */
  findOnlineGlobalAgentId(): string | undefined {
    const row = this.db.prepare("SELECT id FROM agents WHERE kind = 'global' AND status = 'online' ORDER BY last_seen_at DESC, rowid LIMIT 1").get() as
      | { id: string }
      | undefined;
    return row?.id;
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
      .prepare("INSERT INTO design_md_versions (id, project_id, path, hash, created_at, origin, origin_id, origin_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), projectId, path, hash, now(), author.origin, author.originId ?? null, author.originLabel ?? null);
    if (path === PROJECT_STYLE_PATH && !this.isDesignSystemProject(projectId)) this.announceProjectStyleChange(projectId);
  }

  /** Open pages link the project style through a stylesheet: tell them to reload (`design-system-updated`). */
  announceProjectStyleChange(projectId: string): void {
    const row = this.db.prepare("SELECT design_system AS designSystem FROM projects WHERE id = ?").get(projectId) as { designSystem: string | null } | undefined;
    const pageIds = this.listPages(projectId).map((page) => page.id);
    if (row && pageIds.length > 0) this.emit({ type: "design-system-updated", designSystemId: row.designSystem ?? NEUTRAL_DESIGN_SYSTEM_ID, pageIds });
  }

  /** Versions of DESIGN.md (or of another versioned project-level file, `path`), newest first. */
  listDesignMdVersions(projectId: string, path: string = DESIGN_MD_PATH): DesignMdVersion[] {
    const rows = this.db
      .prepare(
        "SELECT id, hash, created_at, origin, origin_id, origin_label FROM design_md_versions WHERE project_id = ? AND path = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(projectId, path) as { id: string; hash: string; created_at: string; origin: DesignMdVersion["origin"]; origin_id: string | null; origin_label: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      content: readFileSync(join(this.blobDir, r.hash), "utf8"),
      createdAt: r.created_at,
      origin: r.origin,
      ...(r.origin_id ? { originId: r.origin_id } : {}),
      ...(r.origin_label ? { originLabel: r.origin_label } : {}),
    }));
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

  createPage(projectId: string, title: string, files: Record<string, string>, createdBy: PageCreator = "user"): Page {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO pages (id, project_id, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, title, createdBy, now());
    this.createVersion(id, files, "Page created", "creation");
    return this.getPage(id)!;
  }

  listPages(projectId: string): Page[] {
    const ids = this.db
      .prepare("SELECT id FROM pages WHERE project_id = ? ORDER BY created_at, rowid")
      .all(projectId) as { id: string }[];
    return ids.map(({ id }) => this.getPage(id)!);
  }

  /** Pages of regular projects (not design systems), most recently changed first, with the time of their last version. */
  listRecentPages(limit: number): { page: Page; updatedAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, MAX(v.created_at) AS updatedAt FROM pages p JOIN versions v ON v.page_id = p.id
         WHERE p.project_id NOT IN (SELECT project_id FROM design_systems)
         GROUP BY p.id ORDER BY updatedAt DESC, p.rowid DESC LIMIT ?`,
      )
      .all(limit) as { id: string; updatedAt: string }[];
    return rows.map(({ id, updatedAt }) => ({ page: this.getPage(id)!, updatedAt }));
  }

  renamePage(id: string, title: string): void {
    this.db.prepare("UPDATE pages SET title = ? WHERE id = ?").run(title, id);
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
      .prepare("SELECT id, project_id, title, created_by FROM pages WHERE id = ?")
      .get(id) as { id: string; project_id: string; title: string; created_by: PageCreator } | undefined;
    if (!row) return undefined;
    const version = this.db
      .prepare("SELECT id, files FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(id) as { id: string; files: string };
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      createdBy: row.created_by,
      version: { id: version.id, files: JSON.parse(version.files) },
    };
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

  createThread(pageId: string, request: CreateThreadRequest): Thread {
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
        `INSERT INTO threads (id, page_id, number, target_kind, element_id, element_kind, element_summary, artboard, selector, element_name, rendering, cell, x_pct, y_pct, title, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, pageId, next, placement.kind, placement.elementId, placement.elementKind, placement.elementSummary, placement.artboard, placement.selector, placement.elementName, placement.rendering, placement.cell, placement.xPct, placement.yPct, title, request.body, request.held ? "held" : "open", now());
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
    return rows.map((row) => withCurrentElement(toThread(row, this.repliesOf(row.id)), elements));
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row && withCurrentElement(toThread(row, this.repliesOf(id)), this.canvasElementsById(row.page_id));
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
        `SELECT t.id, t.page_id, t.number, t.artboard, t.selector, t.element_name, t.rendering, t.cell, t.target_kind, t.element_id, t.element_kind, t.element_summary, t.x_pct, t.y_pct, t.title, t.body, t.status
         FROM threads t WHERE t.page_id = ? AND t.status = 'held' ORDER BY t.created_at, t.rowid`,
      )
      .all(pageId) as ThreadRow[];
    const elements = this.canvasElementsById(pageId);
    return rows.map((row) => withCurrentElement(toThread(row, []), elements));
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
  addReply(threadId: string, body: string, author: ThreadReply["author"] = "claude", createdPageIds: string[] = []): ThreadReply | undefined {
    const thread = this.getThread(threadId);
    if (!thread) return undefined;
    const reply: ThreadReply = { id: randomUUID(), author, body, createdAt: now() };
    this.db
      .prepare("INSERT INTO thread_replies (id, thread_id, author, body, created_at, created_page_ids) VALUES (?, ?, ?, ?, ?, ?)")
      .run(reply.id, threadId, reply.author, body, reply.createdAt, createdPageIds.length > 0 ? JSON.stringify(createdPageIds) : null);
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

  createConversation(pageId: string, title: string): Conversation {
    const createdAt = now();
    const conversation: Conversation = { id: randomUUID(), pageId, title, archived: false, createdAt, exchangeCount: 0, lastActivityAt: createdAt };
    this.db
      .prepare("INSERT INTO conversations (id, page_id, title, created_at) VALUES (?, ?, ?, ?)")
      .run(conversation.id, pageId, title, conversation.createdAt);
    this.emit({ type: "conversation-updated", pageId, conversationId: conversation.id });
    return conversation;
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare(`${CONVERSATION_SELECT} WHERE id = ?`).get(id) as ConversationRow | undefined;
    return row && toConversation(row);
  }

  /** Conversations of a page, oldest first (archived ones included). */
  listConversations(pageId: string): Conversation[] {
    const rows = this.db.prepare(`${CONVERSATION_SELECT} WHERE page_id = ? ORDER BY created_at, rowid`).all(pageId) as ConversationRow[];
    return rows.map(toConversation);
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
  ): ConversationMessage | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const message: ConversationMessage = { id: randomUUID(), author, body, ...choice, createdAt: now() };
    this.db
      .prepare("INSERT INTO conversation_messages (id, conversation_id, author, body, model, effort, created_at, created_page_ids, targets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
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
      );
    this.emit({ type: "conversation-updated", pageId: conversation.pageId, conversationId });
    return this.conversationMessages(conversationId).find((m) => m.id === message.id);
  }

  conversationMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(
        "SELECT id, author, body, model, effort, created_at AS createdAt, created_page_ids AS createdPageIds, targets FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      )
      .all(conversationId) as (ConversationMessage & { model: string | null; effort: Effort | null; createdPageIds: string | null; targets: string | null })[];
    return rows.map(({ model, effort, createdPageIds, targets, ...rest }) => {
      const createdPages = this.createdPagesOf(createdPageIds);
      return { ...rest, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(createdPages ? { createdPages } : {}), ...(targets ? { targets: JSON.parse(targets) as ThreadTarget[] } : {}) };
    });
  }

  private repliesOf(threadId: string): ThreadReply[] {
    const rows = this.db
      .prepare("SELECT id, author, body, created_at AS createdAt, created_page_ids AS createdPageIds FROM thread_replies WHERE thread_id = ? ORDER BY created_at, rowid")
      .all(threadId) as (ThreadReply & { createdPageIds: string | null })[];
    return rows.map(({ createdPageIds, ...reply }) => {
      const createdPages = this.createdPagesOf(createdPageIds);
      return createdPages ? { ...reply, createdPages } : reply;
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
    };
    this.saveDesignMd(designSystem.id, DESIGN_SYSTEM_TOKENS_PATH, Buffer.from(tokens, "utf8"), author);
    return this.createVersion(pageId, pageFiles, message, origin, ref);
  }

  /** Records a version whose files are given as path -> blob hash (hashes of this store). */
  addVersionFromHashes(pageId: string, hashes: Record<string, string>, message: string, origin: VersionOrigin): PageVersionSummary {
    return this.insertVersion(pageId, JSON.stringify(hashes), message, origin);
  }

  /** Stores UTF-8 text as a blob and returns its hash. */
  putText(content: string): string {
    return this.putBlob(Buffer.from(content, "utf8"));
  }

  /** Every version of a page with its file hashes, OLDEST first. */
  listVersionRecords(pageId: string): VersionRecord[] {
    const rows = this.db
      .prepare("SELECT id, files, message, origin, origin_id, origin_label, created_at, diffusion FROM versions WHERE page_id = ? ORDER BY created_at, rowid")
      .all(pageId) as (VersionRow & { files: string; diffusion: number | null })[];
    return rows.map((row) => ({ ...toSummary(row), files: JSON.parse(row.files) as Record<string, string>, diffusion: row.diffusion ?? 1 }));
  }

  /** One file of one version of a page, or undefined if either is unknown. */
  readVersionFile(pageId: string, versionId: string, path: string): Buffer | undefined {
    const row = this.db.prepare("SELECT files FROM versions WHERE id = ? AND page_id = ?").get(versionId, pageId) as { files: string } | undefined;
    const hash = row && (JSON.parse(row.files) as Record<string, string>)[path];
    return hash ? readFileSync(join(this.blobDir, hash)) : undefined;
  }

  /** Records a new version identical to the current one except for one file. */
  setPageFile(pageId: string, path: string, content: string, message: string, origin: VersionOrigin): PageVersionSummary {
    const hashes = { ...this.getPage(pageId)!.version.files, [path]: this.putBlob(Buffer.from(content, "utf8")) };
    return this.insertVersion(pageId, JSON.stringify(hashes), message, origin);
  }

  /** Sets the height of one artboard's manifest entry (writing a manifest when the page had none), as one version. The caller checked the request. */
  setArtboardHeight(pageId: string, file: string, height: number, message: string, origin: VersionOrigin): PageVersionSummary {
    const hash = this.getPage(pageId)!.version.files[MANIFEST_PATH];
    const manifest = hash === undefined ? (defaultManifest(Object.keys(this.getPage(pageId)!.version.files)) as unknown as RawManifest) : (JSON.parse(this.blobText(hash)) as RawManifest);
    const artboards = (manifest.artboards ?? []).map((artboard) => (artboard.file === file ? { ...artboard, height } : artboard));
    return this.setPageFile(pageId, MANIFEST_PATH, JSON.stringify({ ...manifest, artboards }, null, 2), message, origin);
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
      const targetPage = "pageId" in target ? this.getPage(target.pageId)! : this.createPage(source.projectId, target.newPageTitle, starterPageFiles(target.newPageTitle, this.getProject(source.projectId)?.designSystem));
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
        "SELECT id, message, origin, origin_id, origin_label, created_at FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(pageId) as VersionRow[];
    return rows.map(toSummary);
  }

  /** Repoints the page's paths to the hashes of an old version and records that as a new version. */
  restoreVersion(pageId: string, versionId: string): PageVersionSummary | undefined {
    const old = this.db
      .prepare("SELECT files, created_at FROM versions WHERE id = ? AND page_id = ?")
      .get(versionId, pageId) as { files: string; created_at: string } | undefined;
    if (!old) return undefined;
    return this.insertVersion(pageId, old.files, `Restored version of ${old.created_at}`, "restore");
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
    const row: VersionRow = { id: randomUUID(), message, origin, origin_id: ref?.originId ?? null, origin_label: ref?.originLabel ?? null, created_at: now() };
    this.db
      .prepare("INSERT INTO versions (id, page_id, files, created_at, message, origin, origin_id, origin_label, diffusion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, pageId, filesJson, row.created_at, message, origin, row.origin_id, row.origin_label, this.diffusionForNewVersion(pageId, filesJson) ?? null);
    this.emit({ type: "page-updated", pageId, versionId: row.id });
    return toSummary(row);
  }

  /** The diffusion a version recorded now is drawn with: the current one of the design system its manifest names; none for a design system's own pages (they read the draft). */
  private diffusionForNewVersion(pageId: string, filesJson: string): number | undefined {
    if (this.isDesignSystemPage(pageId)) return undefined;
    const manifestHash = (JSON.parse(filesJson) as Record<string, string>)[MANIFEST_PATH];
    const designSystemId = this.designSystemIdOfManifest(manifestHash === undefined ? undefined : this.blobText(manifestHash));
    return this.currentDiffusion(designSystemId)?.number;
  }

  /** Design system a manifest names if it exists, else the neutral one. */
  designSystemIdOfManifest(manifestText: string | undefined): string {
    if (manifestText !== undefined) {
      try {
        const id = parseManifest(manifestText).designSystem;
        if (id !== undefined && this.getDesignSystem(id)) return id;
      } catch {
        // An invalid stored manifest must not break serving the artboard.
      }
    }
    return NEUTRAL_DESIGN_SYSTEM_ID;
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

const PROJECT_SELECT = "SELECT id, title, instructions, design_system AS designSystem FROM projects";

const THREAD_SELECT =
  "SELECT id, page_id, number, artboard, selector, element_name, rendering, cell, target_kind, element_id, element_kind, element_summary, x_pct, y_pct, title, body, status, context, new_session FROM threads";

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

const CONVERSATION_SELECT = `SELECT id, page_id AS pageId, title, archived, created_at AS createdAt,
  (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = conversations.id AND m.author = 'user') AS exchangeCount,
  COALESCE((SELECT MAX(m.created_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id), created_at) AS lastActivityAt
  FROM conversations`;

interface ConversationRow extends Omit<Conversation, "archived"> {
  archived: number;
}

function toConversation(row: ConversationRow): Conversation {
  return { ...row, archived: row.archived === 1 };
}

interface VersionRow {
  id: string;
  message: string;
  origin: VersionOrigin;
  origin_id?: string | null;
  origin_label?: string | null;
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
}

export interface VersionRecord extends PageVersionSummary {
  /** Path -> blob hash. */
  files: Record<string, string>;
  /** Diffusion recorded with the version (1 for versions from before diffusions); meaningless on a design system's own pages. */
  diffusion: number;
}

function toSummary(row: VersionRow): PageVersionSummary {
  return {
    id: row.id,
    message: row.message,
    origin: row.origin,
    ...(row.origin_id ? { originId: row.origin_id } : {}),
    ...(row.origin_label ? { originLabel: row.origin_label } : {}),
    createdAt: row.created_at,
  };
}

function now(): string {
  return new Date().toISOString();
}
