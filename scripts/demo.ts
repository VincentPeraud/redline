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
import { blogPages, designSystemFiles, lumoraPages, reelsPages, type PageSpec } from "./demo-content.js";

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
  edit?: { path: string; find: string; replace: string };
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
  if (scenario.edit) {
    const path = join(run.workingCopyDir, scenario.edit.path);
    const content = readFileSync(path, "utf8").replace(scenario.edit.find, scenario.edit.replace);
    actions.push({ type: "step", tool: "Edit", summary: scenario.edit.path }, { edit: { path: scenario.edit.path, content } });
  }
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
    yield { type: "step", tool: "Read", summary: "screen-2.html" };
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
  const connect = (options: { folder: string; machine: string; kind: "project" | "global"; projectId?: string; model: string; effort: Effort }) =>
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
  const lumoraAgent = await connect({ folder: "~/projets/lumora-reel", machine: "MacBook", kind: "project", projectId: lumora.id, model: "sonnet", effort: "medium" });
  const globalAgent = await connect({ folder: "~/redline-agent", machine: "MacBook", kind: "global", model: "opus", effort: "high" });
  const reelsAgent = await connect({ folder: "~/projets/reels", machine: "iMac", kind: "project", projectId: reels.id, model: "sonnet", effort: "low" });
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

  const thread = async (page: Page, scenario: Scenario, body: string, options: { artboard?: string; selector?: string; held?: boolean } = {}) => {
    scenarios.push(scenario);
    return post<Thread>(`/api/pages/${page.id}/threads`, {
      artboard: options.artboard ?? "screen-1.html",
      selector: options.selector ?? ".cta",
      xPct: 50,
      yPct: 60,
      body,
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

  logStep("conversations and threads");
  const errorPages = await conversation(
    onboarding,
    { match: "Crée une nouvelle page pour les erreurs", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 34, text: "Page « Erreurs » ajoutée au projet, avec 3 artboards dans le style de l'onboarding. La 500 propose de réessayer, la maintenance affiche l'heure de retour." },
    "Pages d'erreur",
    "Crée une nouvelle page pour les erreurs : 404, 500 et maintenance.",
  );
  await untilStatus(errorPages.id, "Pages d'erreur", "answered");

  const button = await thread(
    onboarding,
    { match: "Bouton trop discret", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 78, text: "Fait : bouton en style plein, couleur primaire. J'ai ajouté la règle dans DESIGN.md.", edit: { path: "screen-1.html", find: "<button class=\"cta\">Commencer", replace: "<button class=\"cta\" style=\"width:100%\">Commencer" } },
    "Bouton trop discret\nLe bouton est trop discret, passe-le en plein.",
  );
  await untilStatus(button.id, "Bouton trop discret", "answered");

  const warmer = await conversation(
    onboarding,
    { match: "plus chaleureux", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 51, text: "J'ai réécrit les titres et sous-titres des 3 artboards, et ajouté la règle de ton dans DESIGN.md." },
    "Écrans plus chaleureux",
    "Les textes font trop administratif, rends-les plus chaleureux.",
  );
  await untilStatus(warmer.id, "Écrans plus chaleureux", "answered");

  const week = await thread(
    onboarding,
    { match: "Semaine qui commence lundi", outcome: "answer", model: "Sonnet 5.5", effort: "medium", contextPercent: 9, text: "Corrigé sur l'artboard 3, et noté dans DESIGN.md." },
    "Semaine qui commence lundi\nDans le calendrier, la semaine doit commencer le lundi.",
    { artboard: "screen-3.html" },
  );
  await untilStatus(week.id, "Semaine qui commence lundi", "answered");
  await post(`/api/threads/${week.id}/resolve`);

  await post(`/api/pages/${onboarding.id}/versions`, { message: "Ajuste les marges des artboards", origin: "terminal", files: { ...(await currentFiles(onboarding.id)), "notes.txt": "Marges ajustées depuis le terminal.\n" } });
  await post(`/api/pages/${onboarding.id}/tweaks`, { id: "accent", value: "#D92D20" });

  const hero = await thread(
    lumoraPageByTitle["Landing page"],
    { match: "Hero trop chargé", outcome: "fail" },
    "Hero trop chargé\nAllège le hero : un seul message et un seul bouton.",
    { selector: "h1" },
  );
  await untilStatus(hero.id, "Hero trop chargé", "failed");

  const search = await thread(
    onboarding,
    { match: "Recherche dans la liste", outcome: "hang", model: "Opus 5.5", effort: "high", contextPercent: 12 },
    "Recherche dans la liste\nAjoute une recherche au-dessus de la liste des spécialités.",
    { artboard: "screen-2.html", selector: "h1" },
  );
  await untilStatus(search.id, "Recherche dans la liste", "running");

  const landing = await thread(
    onboarding,
    { match: "Titre de la landing", outcome: "answer", text: "Titre raccourci." },
    "Titre de la landing\nLe titre de la landing est trop long, propose plus court.",
    { selector: "h1" },
  );
  await untilStatus(landing.id, "Titre de la landing", "queued");

  await thread(
    onboarding,
    { match: "Espacement des cartes", outcome: "answer", text: "Fait." },
    "Espacement des cartes\nAugmente l'espacement entre les cartes de spécialité.",
    { artboard: "screen-2.html", selector: ".row", held: true },
  );

  const intro = await thread(
    blogPageByTitle["Article"],
    { match: "Intro de l'article", outcome: "answer", model: "Sonnet 5.5", effort: "low", contextPercent: 6, text: "Raccourcie à deux phrases ; le reste passe dans le premier paragraphe." },
    "Intro de l'article\nL'intro de l'article est trop longue, coupe-la en deux phrases.",
    { selector: "h1" },
  );
  await untilStatus(intro.id, "Intro de l'article", "answered");
  await post(`/api/threads/${intro.id}/resolve`);

  const miniature = await thread(
    reelsPageByTitle["Miniatures"],
    { match: "Miniature du réel 12", outcome: "answer", text: "Titre agrandi." },
    "Miniature du réel 12\nMets le titre plus gros sur la miniature.",
    { artboard: "thumb-3.html", selector: "h1" },
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
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(urlFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

await main();
