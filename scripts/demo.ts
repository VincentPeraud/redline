// `npm run demo`: a real Redline server on a temp data folder, fake agents, and the data the mock-ups show.
// Seeding goes through the public HTTP API and the agent protocol only. Flags: --watch (rebuild the web app on change).
// Env: REDLINE_DEMO_PORT / REDLINE_DEMO_ARTBOARD_PORT (default: free ports), REDLINE_DEMO_URL_FILE (default: ./.demo-url).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  type AgentTokenResponse,
  type ConversationDetail,
  type DesignSystem,
  type Effort,
  type EngineEvent,
  type Page,
  type Project,
  type SessionRow,
  type SessionStatus,
  type Thread,
} from "@redline/shared";
import { startServer } from "../packages/server/src/start.js";
import { startAgent } from "../packages/agent/src/agent.js";
import type { Engine, EngineRunRequest } from "../packages/agent/src/engine.js";
import { FakeEngine, type FakeAction, type FakeRunContext } from "../packages/agent/test/support/fake-engine.js";
import Database from "better-sqlite3";
import {
  blogPages,
  designMdEdits,
  designSystemFiles,
  errorsPage,
  lumoraAssets,
  lumoraDesignMd,
  lumoraPages,
  onboardingExtraArtboard,
  reelsPages,
  type PageSpec,
} from "./demo-content.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(repoRoot, "packages", "web");
const urlFile = resolve(process.env.REDLINE_DEMO_URL_FILE ?? join(repoRoot, ".demo-url"));

/** What a fake session does for the message that contains `match`. */
interface Scenario {
  match: string;
  outcome: "answer" | "hang" | "fail";
  /** The reply posted in the thread (threads) or the summary that becomes Claude's message (conversations). */
  text?: string;
  model?: string;
  effort?: Effort;
  contextPercent?: number;
  /** Files of the working copy the session rewrites (the file's current text goes through `transform`). */
  edits?: { path: string; transform: (text: string) => string }[];
  /** Files the session deletes from the working copy. */
  remove?: string[];
  /** Title of a page the session creates with `create_page`. */
  createPage?: string;
}

const scenarios: Scenario[] = [];

function scenarioOf(message: string): Scenario {
  const scenario = scenarios.find((s) => message.includes(s.match));
  if (!scenario) throw new Error(`No demo scenario for message: ${message.slice(0, 120)}`);
  return scenario;
}

const script = (run: FakeRunContext): FakeAction[] => {
  const scenario = scenarioOf(run.message);
  const threadId = run.message.match(/thread id: ([^)]+)\)/)?.[1];
  const actions: FakeAction[] = [{ type: "step", tool: "Read", summary: "manifest.json" }];
  if (scenario.outcome === "fail") return [...actions, { type: "error", message: "Claude Code s'est arrêté de façon inattendue." }];
  if (scenario.createPage) actions.push({ type: "step", tool: "create_page", summary: scenario.createPage }, { callTool: { name: "create_page", arguments: { title: scenario.createPage } } });
  for (const edit of scenario.edits ?? []) {
    const content = edit.transform(readFileSync(join(run.workingCopyDir, edit.path), "utf8"));
    actions.push({ type: "step", tool: "Edit", summary: edit.path }, { edit: { path: edit.path, content } });
  }
  for (const path of scenario.remove ?? []) actions.push({ type: "step", tool: "Remove", summary: path }, { remove: path });
  const tokens = Math.round(((scenario.contextPercent ?? 10) / 100) * 200_000);
  actions.push({ type: "usage", model: scenario.model ?? "Sonnet 5.5", inputTokens: tokens, cacheTokens: 0, outputTokens: 0, effort: scenario.effort ?? "medium" });
  if (threadId) actions.push({ replyInThread: { threadId, text: scenario.text ?? "Fait." } });
  actions.push({ type: "result", summary: scenario.text ?? "Fait." });
  return actions;
};

/** The shared FakeEngine, plus sessions that never finish (so a thread stays "En cours"). */
function demoEngine(): Engine {
  const fake = new FakeEngine(script);
  const hang = async function* (scenario: Scenario): AsyncGenerator<EngineEvent> {
    const tokens = Math.round(((scenario.contextPercent ?? 10) / 100) * 200_000);
    yield { type: "usage", model: scenario.model ?? "Sonnet 5.5", inputTokens: tokens, cacheTokens: 0, outputTokens: 0, effort: scenario.effort ?? "medium" };
    yield { type: "step", tool: "Read", summary: "ecran-2.html" };
    yield { type: "text", text: "Je cherche où ajouter le champ de recherche au-dessus de la liste des spécialités…" };
    await new Promise<never>(() => undefined);
  };
  const pick = (request: EngineRunRequest, delegate: Engine["start"]) => {
    const scenario = scenarioOf(request.message);
    return scenario.outcome === "hang" ? hang(scenario) : delegate(request);
  };
  return {
    start: (request) => pick(request, (r) => fake.start(r)),
    resume: (request) => pick(request, (r) => fake.resume(r)),
  };
}

const logStep = (message: string) => console.log(`  ${message}`);

async function main(): Promise<void> {
  const watch = process.argv.includes("--watch");
  console.log("Building the web app…");
  await build({ root: webRoot, logLevel: "warn" });
  if (watch) void build({ root: webRoot, logLevel: "warn", build: { watch: {}, emptyOutDir: false } });

  // Agents show their folder as given: relative "~/…" folders live under this temp root.
  const root = mkdtempSync(join(tmpdir(), "redline-demo-"));
  process.chdir(root);
  const dataDir = join(root, "data");
  const server = await startServer({
    dataDir,
    host: "127.0.0.1",
    port: Number(process.env.REDLINE_DEMO_PORT ?? 0),
    artboardPort: Number(process.env.REDLINE_DEMO_ARTBOARD_PORT ?? 0),
    webDir: join(webRoot, "dist"),
    retryDelaysMs: [],
  });

  // The API cannot back-date anything. For history that must look older, the demo (and only the demo) writes
  // older timestamps straight into its own database.
  const demoDb = new Database(join(dataDir, "redline.db"));
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const daysAgo = (days: number) => hoursAgo(days * 24);
  const yesterdayAt = (hour: number, minute: number) => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    date.setHours(hour, minute, 0, 0);
    return date.toISOString();
  };
  const older = {
    latestVersion: (pageId: string, iso: string) =>
      demoDb.prepare("UPDATE versions SET created_at = ? WHERE id = (SELECT id FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)").run(iso, pageId),
    latestDesignMd: (projectId: string, iso: string) =>
      demoDb.prepare("UPDATE design_md_versions SET created_at = ? WHERE id = (SELECT id FROM design_md_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)").run(iso, projectId),
    conversation: (id: string, iso: string) => {
      demoDb.prepare("UPDATE conversations SET created_at = ? WHERE id = ?").run(iso, id);
      demoDb.prepare("UPDATE conversation_messages SET created_at = ? WHERE conversation_id = ?").run(iso, id);
    },
    thread: (id: string, iso: string) => {
      demoDb.prepare("UPDATE threads SET created_at = ? WHERE id = ?").run(iso, id);
      demoDb.prepare("UPDATE thread_replies SET created_at = ? WHERE thread_id = ?").run(iso, id);
    },
  };

  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await fetch(server.url + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
  const get = <T>(path: string) => call<T>("GET", path);
  const post = <T>(path: string, body?: unknown) => call<T>("POST", path, body);

  async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const statusOf = async (id: string): Promise<SessionStatus | undefined> => (await get<SessionRow[]>("/api/sessions")).find((s) => s.id === id)?.status;
  const untilStatus = (id: string, name: string, expected: SessionStatus) => until(`${name} to be ${expected}`, async () => (await statusOf(id)) === expected);

  const { token } = await get<AgentTokenResponse>("/api/agent-token");
  const connect = (options: { folder: string; machine: string; kind: "project" | "global"; projectIds?: string[]; model: string; effort: Effort }) =>
    startAgent({ serverUrl: server.url, token, engine: demoEngine(), ...options });

  async function currentFiles(pageId: string): Promise<Record<string, string>> {
    const checkout = await fetch(`${server.url}/agent-api/pages/${pageId}/files`, { headers: { authorization: `Bearer ${token}` } });
    return ((await checkout.json()) as { files: Record<string, string> }).files;
  }

  logStep("design systems");
  const dsLumora = await post<DesignSystem>("/api/design-systems", { title: "DS Lumora", files: designSystemFiles("#d92d20") });
  await post<DesignSystem>("/api/design-systems", { title: "DS Lumora Marketing", files: designSystemFiles("#0f766e") });

  logStep("projects and agents");
  const lumora = await post<Project>("/api/projects", { title: "Lumora", designSystem: dsLumora.id });
  const blog = await post<Project>("/api/projects", { title: "Blog Lumora", designSystem: dsLumora.id });
  const reels = await post<Project>("/api/projects", { title: "Réels ComfyUI" });
  const lumoraAgent = await connect({ folder: "~/projets/lumora-reel", machine: "MacBook", kind: "project", projectIds: [lumora.id], model: "sonnet", effort: "medium" });
  const globalAgent = await connect({ folder: "~/redline-agent", machine: "MacBook", kind: "global", model: "opus", effort: "high" });
  const reelsAgent = await connect({ folder: "~/projets/reels", machine: "iMac", kind: "project", projectIds: [reels.id], model: "sonnet", effort: "low" });
  reelsAgent.close();
  await until("the reels agent to go offline", async () => (await get<{ folder: string; status: string }[]>("/api/agents")).some((a) => a.folder === "~/projets/reels" && a.status === "offline"));

  logStep("pages");
  const createPages = async (project: Project, specs: PageSpec[]): Promise<Record<string, Page>> => {
    const pages: Record<string, Page> = {};
    for (const spec of specs) pages[spec.title] = await post<Page>(`/api/projects/${project.id}/pages`, { title: spec.title, files: spec.files });
    return pages;
  };
  const lumoraPageByTitle = await createPages(lumora, lumoraPages(dsLumora.id));
  const blogPageByTitle = await createPages(blog, blogPages(dsLumora.id));
  const reelsPageByTitle = await createPages(reels, reelsPages);
  const onboarding = lumoraPageByTitle["Onboarding"];

  /** `titleAndBody`: the thread name on the first line, the comment itself on the following ones. */
  const thread = async (page: Page, scenario: Scenario, titleAndBody: string, options: { artboard?: string; selector?: string; held?: boolean; elementName?: string } = {}) => {
    scenarios.push(scenario);
    const [title, ...rest] = titleAndBody.split("\n");
    return post<Thread>(`/api/pages/${page.id}/threads`, {
      title,
      artboard: options.artboard ?? "ecran-1.html",
      selector: options.selector ?? ".cta",
      elementName: options.elementName,
      xPct: 50,
      yPct: 60,
      body: rest.join("\n"),
      held: options.held,
      model: scenario.model?.toLowerCase().split(" ")[0],
      effort: scenario.effort,
    });
  };
  const conversation = async (page: Page, scenario: Scenario, title: string, body: string) => {
    scenarios.push(scenario);
    const created = await post<ConversationDetail>(`/api/pages/${page.id}/conversations`, { title });
    await post(`/api/conversations/${created.id}/messages`, { body, model: scenario.model?.toLowerCase().split(" ")[0], effort: scenario.effort });
    return created;
  };

  logStep("assets and DESIGN.md");
  for (const [name, content] of Object.entries(lumoraAssets())) {
    const path = name.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${server.url}/api/projects/${lumora.id}/assets/${path}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: typeof content === "string" ? content : new Uint8Array(content) });
    if (!res.ok) throw new Error(`PUT asset ${name} -> ${res.status}`);
  }
  const designMdRes = await fetch(`${server.url}/api/projects/${lumora.id}/design-md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: lumoraDesignMd }) });
  if (!designMdRes.ok) throw new Error(`PUT design-md -> ${designMdRes.status}`);

  // History is seeded oldest first: versions are ordered by date, and the API cannot back-date, so each step is
  // written with an older timestamp straight into the demo's own database (never through a production API).
  logStep("history: versions, deleted artboard, DESIGN.md origins");
  older.latestDesignMd(lumora.id, daysAgo(9));
  older.latestVersion(onboarding.id, daysAgo(9));
  older.latestVersion(lumoraPageByTitle["Landing page"].id, daysAgo(1));
  older.latestVersion(lumoraPageByTitle["Tableau de bord remplaçant"].id, daysAgo(3));
  older.latestVersion(lumoraPageByTitle["Comparaison des en-têtes"].id, hoursAgo(1));
  older.latestVersion(lumoraPageByTitle["Profil médecin"].id, daysAgo(8));
  older.latestVersion(blogPageByTitle["Article"].id, daysAgo(2));

  const onboardingFiles = await currentFiles(onboarding.id);
  const manifest = JSON.parse(onboardingFiles["manifest.json"]!) as { artboards: { file: string; title?: string; width: number; height: number; x: number; y: number }[] };
  const last = manifest.artboards[manifest.artboards.length - 1]!;
  manifest.artboards.push({ file: onboardingExtraArtboard.file, title: onboardingExtraArtboard.title, width: onboardingExtraArtboard.width, height: onboardingExtraArtboard.height, x: last.x + last.width + 60, y: 0 });
  await post(`/api/pages/${onboarding.id}/versions`, {
    message: "Ajoute l'artboard Confirmation",
    origin: "terminal",
    files: { ...onboardingFiles, "manifest.json": JSON.stringify(manifest, null, 2), [onboardingExtraArtboard.file]: onboardingExtraArtboard.html },
  });
  older.latestVersion(onboarding.id, daysAgo(3));

  const headers = await conversation(
    onboarding,
    { match: "3 variantes de header", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 22, text: "Trois variantes de header à comparer : A clair, B teinté, C plein. J'ai ajouté un tweak pour basculer entre elles." },
    "Variantes du header",
    "Propose 3 variantes de header pour l'onboarding.",
  );
  await untilStatus(headers.id, "Variantes du header", "answered");
  older.conversation(headers.id, daysAgo(3));

  const warmer = await conversation(
    onboarding,
    { match: "plus chaleureux", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 51, text: "J'ai réécrit les titres et sous-titres des 3 artboards, et ajouté la règle de ton dans DESIGN.md.", edits: [{ path: "DESIGN.md", transform: designMdEdits.tone }] },
    "Écrans plus chaleureux",
    "Les textes font trop administratif, rends-les plus chaleureux.",
  );
  await untilStatus(warmer.id, "Écrans plus chaleureux", "answered");
  older.conversation(warmer.id, yesterdayAt(9, 15));
  older.latestVersion(onboarding.id, yesterdayAt(9, 15));
  older.latestDesignMd(lumora.id, yesterdayAt(9, 15));

  const steps = await thread(
    onboarding,
    {
      match: "trop d'étapes, retire",
      outcome: "answer",
      model: "Sonnet 5.5",
      effort: "medium",
      contextPercent: 8,
      text: "Artboard « Confirmation » retiré : l'inscription se termine sur le calendrier.",
      edits: [
        {
          path: "manifest.json",
          transform: (text) => {
            const current = JSON.parse(text) as { artboards: { file: string }[] };
            return JSON.stringify({ ...current, artboards: current.artboards.filter((a) => a.file !== onboardingExtraArtboard.file) }, null, 2);
          },
        },
      ],
      remove: [onboardingExtraArtboard.file],
    },
    "Trop d'étapes\nL'onboarding a trop d'étapes, retire l'artboard de confirmation.",
    { artboard: "ecran-3.html", selector: ".cta", elementName: "bouton « Terminer »" },
  );
  await untilStatus(steps.id, "Trop d'étapes", "answered");
  await post(`/api/threads/${steps.id}/resolve`);
  older.thread(steps.id, yesterdayAt(10, 20));
  older.latestVersion(onboarding.id, yesterdayAt(10, 20));

  const radios = await thread(
    onboarding,
    { match: "menu déroulant des spécialités", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 14, text: "Fait : les spécialités sont en boutons radio. Règle ajoutée à DESIGN.md.", edits: [{ path: "DESIGN.md", transform: designMdEdits.radio }] },
    "Liste des spécialités\nRemplace le menu déroulant des spécialités par des boutons radio.",
    { artboard: "ecran-2.html", selector: ".choices", elementName: "bloc" },
  );
  await untilStatus(radios.id, "Liste des spécialités", "answered");
  await post(`/api/threads/${radios.id}/resolve`);
  older.thread(radios.id, yesterdayAt(11, 5));
  older.latestVersion(onboarding.id, yesterdayAt(11, 5));
  older.latestDesignMd(lumora.id, yesterdayAt(11, 5));

  const week = await thread(
    onboarding,
    { match: "la semaine doit commencer le lundi", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 9, text: "Corrigé sur l'artboard 3, et noté dans DESIGN.md.", edits: [{ path: "DESIGN.md", transform: designMdEdits.week }] },
    "Calendrier\nDans le calendrier, la semaine doit commencer le lundi.",
    { artboard: "ecran-3.html", selector: ".days", elementName: "bloc" },
  );
  await untilStatus(week.id, "Calendrier", "answered");
  await post(`/api/threads/${week.id}/resolve`);
  older.thread(week.id, yesterdayAt(14, 30));
  older.latestVersion(onboarding.id, yesterdayAt(14, 30));
  older.latestDesignMd(lumora.id, yesterdayAt(14, 30));

  const beforeTerminal = await currentFiles(onboarding.id);
  await post(`/api/pages/${onboarding.id}/versions`, {
    message: "Ajuste les marges de l'artboard",
    origin: "terminal",
    files: { ...beforeTerminal, "ecran-1.html": beforeTerminal["ecran-1.html"]!.replace("<main", "<!-- marges revues depuis le terminal -->\n<main"), "notes.txt": "Marges ajustées depuis le terminal.\n" },
  });
  older.latestVersion(onboarding.id, yesterdayAt(16, 40));

  logStep("conversations and threads");
  const errorPages = await conversation(
    onboarding,
    { match: "Crée une nouvelle page pour les erreurs", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 34, createPage: "Erreurs", text: "Page « Erreurs » ajoutée au projet, avec 3 artboards dans le style de l'onboarding. La 500 propose de réessayer, la maintenance affiche l'heure de retour." },
    "Pages d'erreur",
    "Crée une nouvelle page pour les erreurs : 404, 500 et maintenance.",
  );
  await untilStatus(errorPages.id, "Pages d'erreur", "answered");
  const erreurs = (await get<Page[]>(`/api/projects/${lumora.id}/pages`)).find((p) => p.title === "Erreurs")!;
  const errorsSpec = errorsPage(dsLumora.id);
  await post(`/api/pages/${erreurs.id}/versions`, { message: "Ajoute les artboards 404, 500 et maintenance", origin: "terminal", files: errorsSpec.files });

  scenarios.push({ match: "écran hors ligne", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 34, text: "Artboard hors ligne ajouté à côté de l'écran 3." });
  await post(`/api/conversations/${errorPages.id}/messages`, { body: "Sur cette page, ajoute un artboard pour l'écran hors ligne, à côté de l'écran 3." });
  await until("the second error-page exchange to be answered", async () => (await get<ConversationDetail>(`/api/conversations/${errorPages.id}`)).exchangeCount === 2 && (await statusOf(errorPages.id)) === "answered");

  const button = await thread(
    onboarding,
    {
      match: "bouton est trop discret",
      outcome: "answer",
      model: "Sonnet 5.5",
      effort: "medium",
      contextPercent: 78,
      text: "Bouton principal plein, couleur primaire",
      edits: [
        { path: "ecran-1.html", transform: (text) => text.replace('<button class="cta">Créer mon compte', '<button class="cta" style="width:100%">Créer mon compte') },
        { path: "DESIGN.md", transform: designMdEdits.button },
      ],
    },
    "Bouton trop discret\nLe bouton est trop discret, passe-le en plein.",
    { elementName: "bouton « Créer mon compte »" },
  );
  await untilStatus(button.id, "Bouton trop discret", "answered");

  const hero = await thread(
    lumoraPageByTitle["Landing page"],
    { match: "Allège le hero", outcome: "fail" },
    "Hero trop chargé\nAllège le hero : un seul message et un seul bouton.",
    { selector: "h1", elementName: "titre « Trouve ton prochain rendez-vou… »" },
  );
  await untilStatus(hero.id, "Hero trop chargé", "failed");

  const search = await thread(
    onboarding,
    { match: "recherche au-dessus", outcome: "hang", model: "Opus 5.5", effort: "high", contextPercent: 12 },
    "Recherche dans la liste\nAjoute une recherche au-dessus de la liste des spécialités.",
    { artboard: "ecran-2.html", selector: ".choices", elementName: "bloc" },
  );
  await untilStatus(search.id, "Recherche dans la liste", "running");

  const landing = await thread(
    onboarding,
    { match: "titre de la landing est trop long", outcome: "answer", text: "Titre raccourci." },
    "Titre de la landing\nLe titre de la landing est trop long, propose plus court.",
    { selector: "h1", elementName: "titre « Bienvenue sur Lumora »" },
  );
  await untilStatus(landing.id, "Titre de la landing", "queued");

  await thread(
    onboarding,
    { match: "une ligne maximum", outcome: "answer", text: "Fait." },
    "Raccourcis le titre\nRaccourcis le titre, une ligne maximum.",
    { selector: "h1", held: true, elementName: "titre « Bienvenue sur Lumora »" },
  );

  const intro = await thread(
    blogPageByTitle["Article"],
    { match: "intro de l'article est trop longue", outcome: "answer", model: "Sonnet 5.5", effort: "low", contextPercent: 6, text: "Raccourcie à deux phrases ; le reste passe dans le premier paragraphe." },
    "Intro de l'article\nL'intro de l'article est trop longue, coupe-la en deux phrases.",
    { selector: "h1", elementName: "titre « Pourquoi le rendez-vous en ligne… »" },
  );
  await untilStatus(intro.id, "Intro de l'article", "answered");
  await post(`/api/threads/${intro.id}/resolve`);

  const miniature = await thread(
    reelsPageByTitle["Miniatures"],
    { match: "plus gros sur la miniature", outcome: "answer", text: "Titre agrandi." },
    "Miniature du réel 12\nMets le titre plus gros sur la miniature.",
    { artboard: "thumb-3.html", selector: "h1", elementName: "titre « Réel 12 »" },
  );
  await untilStatus(miniature.id, "Miniature du réel 12", "waiting-agent");

  writeFileSync(urlFile, server.url);
  console.log(`\nRedline demo ready: ${server.url}`);
  console.log(`  artboards: ${server.artboardOrigin}`);
  console.log(`  URL written to ${urlFile} (the capture tool reads it, or $REDLINE_DEMO_URL)`);
  console.log("  Ctrl+C to stop.\n");

  const stop = async () => {
    lumoraAgent.close();
    globalAgent.close();
    demoDb.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(urlFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

await main();
