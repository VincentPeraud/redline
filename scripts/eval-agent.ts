// `npm run eval:agent`: real Claude sessions (headless `claude -p`) use Redline through `redline mcp` on written scenarios,
// against a throwaway server; then the pages they published are checked in a browser and reported with screenshots.
// Costs one real Claude session per scenario. Flags: --scenario <name> (repeatable; default: all of scripts/eval-scenarios),
// --model <model>, --budget <usd per scenario, default 3>, --keep (leave the server running to look at the pages).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { MANIFEST_PATH, defaultManifest, parseManifest, parseTokens, type AgentTokenResponse, type DesignMdResponse, type Manifest, type Page, type PageGaps } from "@redline/shared";
import { startServer } from "../packages/server/src/start.js";
import { login } from "../packages/agent/src/login.js";
import { linkFolder } from "../packages/agent/src/link.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenarioDir = join(repoRoot, "scripts", "eval-scenarios");
const cli = join(repoRoot, "packages", "agent", "dist", "cli.js");
const SESSION_TIMEOUT_MS = 20 * 60_000;

const { values } = parseArgs({
  options: {
    scenario: { type: "string", multiple: true },
    model: { type: "string" },
    budget: { type: "string", default: "3" },
    keep: { type: "boolean", default: false },
  },
});

interface SessionResult {
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  answer: string;
  toolCalls: Record<string, number>;
  /** Redline tool calls that came back as errors (a refused publish, a wrong id...). */
  toolErrors: { tool: string; text: string }[];
}

interface PageReport {
  title: string;
  url: string;
  screenshot: string;
  gaps: number;
  emptyArtboards: string[];
  problems: string[];
}

/** Runs one headless Claude Code session in `folder`, with only the Redline MCP, and reads its stream-json events. */
function runClaude(prompt: string, folder: string, configDir: string, transcript: string): Promise<SessionResult> {
  const mcpConfig = join(folder, "..", `mcp-${basename(folder)}.json`);
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { redline: { command: "node", args: [cli, "mcp"], env: { REDLINE_CONFIG_DIR: configDir } } } }));
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "mcp__redline__*", "Read", "Write", "Edit", "Glob", "Grep",
    "--no-session-persistence",
    "--max-budget-usd", values.budget!,
    ...(values.model ? ["--model", values.model] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: folder, stdio: ["ignore", "pipe", "inherit"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), SESSION_TIMEOUT_MS);
    const result: SessionResult = { costUsd: null, durationMs: null, turns: null, answer: "", toolCalls: {}, toolErrors: [] };
    const toolNames = new Map<string, string>();
    let buffer = "";
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        log += `${line}\n`;
        let event: { type?: string; message?: { content?: unknown }; total_cost_usd?: number; duration_ms?: number; num_turns?: number; result?: string };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const content = Array.isArray(event.message?.content) ? (event.message!.content as Record<string, unknown>[]) : [];
        for (const part of content) {
          if (part.type === "tool_use") {
            const name = String(part.name);
            toolNames.set(String(part.id), name);
            result.toolCalls[name] = (result.toolCalls[name] ?? 0) + 1;
            process.stdout.write(`    · ${name.replace("mcp__redline__", "")}\n`);
          }
          if (part.type === "tool_result" && part.is_error) {
            const tool = toolNames.get(String(part.tool_use_id)) ?? "?";
            const text = Array.isArray(part.content) ? (part.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") : String(part.content ?? "");
            if (tool.startsWith("mcp__redline__")) result.toolErrors.push({ tool: tool.replace("mcp__redline__", ""), text });
          }
        }
        if (event.type === "result") {
          result.costUsd = event.total_cost_usd ?? null;
          result.durationMs = event.duration_ms ?? null;
          result.turns = event.num_turns ?? null;
          result.answer = event.result ?? "";
        }
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      writeFileSync(transcript, log);
      resolve(result);
    });
  });
}

/** Opens a page's canvas, measures every box in canvas pixels, finds what overlaps or is crossed, and screenshots the whole canvas. */
async function checkCanvas(browser: Browser, url: string, manifest: Manifest, screenshot: string): Promise<string[]> {
  const tab = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  // tsx keeps function names with an `__name` helper, which the page must know to run the functions sent to it.
  await tab.addInitScript("globalThis.__name = (fn) => fn");
  try {
    await tab.goto(url);
    await tab.locator("iframe").first().waitFor({ timeout: 15_000 }).catch(() => {});
    await tab.waitForTimeout(2500);
    const measured = await tab.evaluate((files: string[]) => {
      const world = [...document.querySelectorAll<HTMLElement>("div")].find((d) => d.style.transform.includes("scale("));
      if (!world) return null;
      world.style.transform = "translate(0px, 0px) scale(1)";
      const origin = world.getBoundingClientRect();
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
      };
      // An artboard is its clips (one per rendering for a responsive artboard), without the name strip above it.
      const artboards = files.flatMap((file) => {
        const clips = [...document.querySelectorAll(`[data-artboard="${CSS.escape(file)}"] iframe`)].map((frame) => rect(frame.parentElement!));
        if (clips.length === 0) return [];
        const x = Math.min(...clips.map((c) => c.x));
        const y = Math.min(...clips.map((c) => c.y));
        return [{ name: file, box: { x, y, width: Math.max(...clips.map((c) => c.x + c.width)) - x, height: Math.max(...clips.map((c) => c.y + c.height)) - y } }];
      });
      const elements = [...document.querySelectorAll("[data-canvas-element-id]")].map((el) => ({
        name: el.getAttribute("data-canvas-element-id")!,
        kind: el.hasAttribute("data-canvas-sticky") ? "sticky" : el.hasAttribute("data-canvas-text") ? "text" : el.hasAttribute("data-canvas-link") ? "link" : el.hasAttribute("data-canvas-image") ? "image" : el.querySelector("[data-canvas-title]") ? "title" : "shape",
        box: rect(el),
        cut: [...el.querySelectorAll<HTMLElement>("[data-canvas-title]")].some((t) => t.scrollWidth > t.clientWidth + 1),
      }));
      const arrows = [...document.querySelectorAll<SVGSVGElement>("svg[data-canvas-arrow]")].map((svg) => {
        // The line itself: the arrowhead's path lives in a <marker>, in its own small coordinates.
        const path = svg.querySelector(":scope > path") as SVGPathElement | null;
        if (!path) return [];
        const length = path.getTotalLength();
        return Array.from({ length: 41 }, (_, i) => {
          const p = path.getPointAtLength((length * i) / 40);
          return { x: p.x, y: p.y };
        });
      });
      return { artboards, elements, arrows };
    }, manifest.artboards.map((a) => a.file));
    if (!measured) return ["the canvas did not load"];

    const problems: string[] = [];
    // Script errors and missing files the artboards reported, as the user sees them in "Erreurs des artboards".
    const errorsButton = tab.getByTestId("errors-button");
    if ((await errorsButton.count()) > 0) {
      await errorsButton.click();
      for (const row of await tab.locator("[data-errors-of]").all()) {
        const messages = await row.locator("[data-error]").allInnerTexts();
        problems.push(`artboard ${await row.getAttribute("data-errors-of")} reports errors: ${messages.join(" | ")}`);
      }
      await errorsButton.click();
    }
    const overlap = (a: Box, b: Box) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 4 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 4;
    const inside = (p: { x: number; y: number }, b: Box) => p.x > b.x + 4 && p.x < b.x + b.width - 4 && p.y > b.y + 4 && p.y < b.y + b.height - 4;
    const { artboards, elements, arrows } = measured;
    artboards.forEach((a, i) => artboards.slice(0, i).forEach((b) => overlap(a.box, b.box) && problems.push(`artboards ${a.name} and ${b.name} overlap`)));
    const solid = elements.filter((e) => e.kind !== "shape");
    solid.forEach((a, i) => {
      solid.slice(0, i).forEach((b) => overlap(a.box, b.box) && problems.push(`${a.kind} ${a.name} overlaps ${b.kind} ${b.name}`));
      artboards.forEach((b) => overlap(a.box, b.box) && problems.push(`${a.kind} ${a.name} covers artboard ${b.name}`));
      if (a.cut) problems.push(`title ${a.name} is cut ("…")`);
    });
    const arrowElements = manifest.elements.filter((e) => e.kind === "arrow");
    arrows.forEach((samples, i) => {
      const arrow = arrowElements[i];
      const ends = arrow ? [arrow.from, arrow.to].filter((end): end is string => typeof end === "string") : [];
      const crossed = [...artboards, ...solid].filter((b) => !ends.includes(b.name) && samples.some((p) => inside(p, b.box)));
      if (crossed.length) problems.push(`arrow ${arrow?.id ?? i} crosses ${crossed.map((b) => b.name).join(", ")}`);
    });

    // Fit everything in the stage for the screenshot.
    const all = [...artboards, ...elements].map((b) => b.box);
    if (all.length) {
      const minX = Math.min(...all.map((b) => b.x)) - 60;
      const minY = Math.min(...all.map((b) => b.y)) - 140;
      const maxX = Math.max(...all.map((b) => b.x + b.width)) + 60;
      const maxY = Math.max(...all.map((b) => b.y + b.height)) + 60;
      await tab.evaluate(({ minX, minY, maxX, maxY }) => {
        const world = [...document.querySelectorAll<HTMLElement>("div")].find((d) => d.style.transform.includes("scale("))!;
        const stage = world.parentElement!.getBoundingClientRect();
        // The stage may run past the window: fit in what is visible, above the zoom bar.
        const visibleWidth = Math.min(stage.width, window.innerWidth - stage.left);
        const visibleHeight = Math.min(stage.height, window.innerHeight - stage.top) - 80;
        const scale = Math.min(visibleWidth / (maxX - minX), visibleHeight / (maxY - minY), 1);
        // Frozen: the app re-renders its own view (late artboard heights) and would undo the fit.
        const fitted = `translate(${-minX * scale}px, ${-minY * scale}px) scale(${scale})`;
        Object.defineProperty(world.style, "transform", { get: () => fitted, set: () => {}, configurable: true });
        world.style.setProperty("transform", fitted);
      }, { minX, minY, maxX, maxY });
      await tab.waitForTimeout(500);
    }
    await tab.screenshot({ path: screenshot });
    return problems;
  } finally {
    await tab.close();
  }
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function main(): Promise<void> {
  const names = values.scenario ?? readdirSync(scenarioDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  const runDir = join(repoRoot, ".scratch", "eval-runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });

  console.log("Building the web app…");
  const webDir = mkdtempSync(join(tmpdir(), "redline-eval-web-"));
  await build({ root: join(repoRoot, "packages", "web"), logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  const server = await startServer({ dataDir: mkdtempSync(join(tmpdir(), "redline-eval-data-")), port: 0, artboardPort: 0, host: "127.0.0.1", webDir });
  const { token } = (await (await fetch(`${server.url}/api/agent-token`)).json()) as AgentTokenResponse;
  console.log(`Redline at ${server.url}`);
  const browser = await chromium.launch();

  const sections: string[] = [];
  const summary: string[] = [];
  for (const name of names) {
    const prompt = readFileSync(join(scenarioDir, `${name}.md`), "utf8").trim();
    console.log(`\n▶ ${name}`);
    const work = mkdtempSync(join(tmpdir(), "redline-eval-"));
    const folder = join(work, "project");
    const configDir = join(work, "config");
    mkdirSync(folder);
    login({ configDir, serverUrl: server.url, token });
    const projectId = await linkFolder({ folder, serverUrl: server.url, token, choose: async () => ({ create: `Eval · ${name}` }) });

    const session = await runClaude(prompt, folder, configDir, join(runDir, `${name}.jsonl`));
    const pages = (await (await fetch(`${server.url}/api/projects/${projectId}/pages`)).json()) as Page[];
    const reports: PageReport[] = [];
    for (const [i, page] of pages.entries()) {
      const files = page.version.files;
      const read = async (path: string) => (await fetch(`${server.url}/api/pages/${page.id}/files/${encodeURIComponent(path)}`)).text();
      const manifest = files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(await read(MANIFEST_PATH));
      const emptyArtboards: string[] = [];
      for (const { file } of manifest.artboards) {
        const text = (await read(file)).replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (text.length < 15) emptyArtboards.push(file);
      }
      const { gaps } = (await (await fetch(`${server.url}/api/pages/${page.id}/gaps`)).json()) as PageGaps;
      const screenshot = `${name}-${i + 1}.png`;
      const url = `${server.url}/#/pages/${page.id}`;
      const problems = manifest.artboards.length === 0 && manifest.elements.length === 0 ? ["empty page"] : await checkCanvas(browser, url, manifest, join(runDir, screenshot));
      reports.push({ title: page.title, url, screenshot, gaps: gaps.length, emptyArtboards, problems });
    }

    // The eval's projects have no design system: Claude is expected to write the project style before the first artboard.
    const styleRes = await fetch(`${server.url}/api/projects/${projectId}/project-style`);
    const projectStyle = styleRes.ok ? ((await styleRes.json()) as DesignMdResponse).content : undefined;
    const styleTokens = projectStyle === undefined ? undefined : parseTokens(projectStyle).length;
    const styleLabel = styleTokens === undefined ? "project style unavailable" : styleTokens === 0 ? "project style empty" : `${styleTokens} token(s)`;

    const issues = (styleTokens === 0 || styleTokens === undefined ? 1 : 0) + session.toolErrors.length + reports.reduce((n, r) => n + r.problems.length + r.emptyArtboards.length + (r.gaps > 0 ? 1 : 0), 0);
    const cost = session.costUsd === null ? "?" : `$${session.costUsd.toFixed(2)}`;
    summary.push(`${issues === 0 ? "✓" : "✗"} ${name}: ${pages.length} page(s), ${styleLabel}, ${reports.reduce((n, r) => n + r.gaps, 0)} gap(s), ${reports.reduce((n, r) => n + r.problems.length, 0)} layout problem(s), ${session.toolErrors.length} refused call(s), ${cost}`);
    console.log(`  ${summary[summary.length - 1]}`);
    sections.push(`<section><h2>${issues === 0 ? "✓" : "✗"} ${escapeHtml(name)}</h2>
<p class="prompt">${escapeHtml(prompt)}</p>
<p class="meta">${cost} · ${session.turns ?? "?"} turns · ${session.durationMs === null ? "?" : Math.round(session.durationMs / 1000)} s · tools: ${escapeHtml(Object.entries(session.toolCalls).map(([t, n]) => `${t.replace("mcp__redline__", "")} ×${n}`).join(", "))} · <a href="${name}.jsonl">transcript</a></p>
<h3>Project style · ${styleTokens === undefined ? "indisponible" : styleTokens === 0 ? "vide" : `${styleTokens} token(s)`}</h3>
${projectStyle === undefined ? "<p><b>The project style could not be read.</b></p>" : styleTokens === 0 ? "<p><b>Claude wrote no project style.</b></p>" : `<pre>${escapeHtml(projectStyle.trim())}</pre>`}
${session.toolErrors.length ? `<h3>Refused calls</h3><ul>${session.toolErrors.map((e) => `<li><b>${escapeHtml(e.tool)}</b>: ${escapeHtml(e.text)}</li>`).join("")}</ul>` : ""}
${reports.map((r) => `<h3>${escapeHtml(r.title)} · ${r.gaps} écart(s)</h3>
${r.problems.length || r.emptyArtboards.length ? `<ul>${[...r.problems, ...r.emptyArtboards.map((f) => `empty artboard ${f}`)].map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : "<p>No layout problem.</p>"}
<img src="${r.screenshot}" alt="">`).join("\n")}
${pages.length === 0 ? "<p><b>No page was created.</b></p>" : ""}
<details><summary>Claude's answer</summary><pre>${escapeHtml(session.answer)}</pre></details></section>`);
  }

  writeFileSync(join(runDir, "report.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent eval</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px auto;max-width:1200px;padding:0 16px;color:#18181b;background:#f6f5f2}
section{background:#fff;border:1px solid #e4e2dc;border-radius:12px;padding:16px 20px;margin:16px 0}
.prompt{color:#3f3f46}.meta{color:#5f5f68;font-size:13px}img{max-width:100%;border:1px solid #e4e2dc;border-radius:8px}pre{white-space:pre-wrap}
</style></head><body><h1>Agent eval</h1><pre>${escapeHtml(summary.join("\n"))}</pre>${sections.join("\n")}</body></html>`);
  console.log(`\n${summary.join("\n")}\nReport: ${join(runDir, "report.html")}`);

  await browser.close();
  if (values.keep) {
    console.log(`Server still running at ${server.url} (Ctrl-C to stop).`);
    return;
  }
  await server.close();
}

await main();
