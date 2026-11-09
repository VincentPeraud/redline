import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type ArtboardCapability, type DesignSystem, type Page, type Project } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer, type StartOptions } from "../src/start.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
const tokens = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111;`).join("\n")}\n}\n`;
const json = { "content-type": "application/json" };

describe("artboard viewing capability", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  const human = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "amartin", "remote-name": "Ariane Martin", "remote-email": "ariane@example.com" };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-capability-"));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = async (options: Partial<StartOptions> = {}) => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "proxy", proxySecrets: { human: HUMAN, machine: MACHINE }, ...options });
    return server;
  };
  const api = (path: string, body?: unknown) =>
    fetch(server!.url + path, { method: body === undefined ? "GET" : "POST", headers: { ...human, ...json }, body: body === undefined ? undefined : JSON.stringify(body) });
  const createProject = async (designSystem?: string) => (await (await api("/api/projects", { title: "Acme", designSystem })).json()) as Project;
  const createDesignSystem = async () => (await (await api("/api/design-systems", { title: "DS", files: { "tokens.css": tokens, "index.html": html } })).json()) as DesignSystem;
  const createPage = async (project: Project) =>
    (await (await api(`/api/projects/${project.id}/pages`, { title: "Flow", files: { "a.html": html, "assets/logo.svg": "<svg/>" } })).json()) as Page;
  const capabilityOf = async (project: { id: string }) => ((await (await api(`/api/projects/${project.id}/artboard-capability`)).json()) as ArtboardCapability).capability;
  const artboard = (path: string) => fetch(server!.artboardOrigin + path, { headers: { [PROXY_SECRET_HEADER]: HUMAN } });

  it("serves an artboard, its bridge and its stylesheets only under a capability of its project", async () => {
    await start();
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const page = await createPage(project);
    const capability = await capabilityOf(project);

    expect((await artboard(`/pages/${page.id}/a.html`)).status).toBe(404);
    const served = await artboard(`/c/${capability}/pages/${page.id}/a.html`);
    expect(served.status).toBe(200);
    const markup = await served.text();
    expect(markup).toContain(`/c/${capability}/design-systems/${ds.id}/diffusions/1/tokens.css`);
    expect(markup).toContain(`/c/${capability}/__redline/bridge.js`);

    expect((await artboard(`/c/${capability}/design-systems/${ds.id}/diffusions/1/tokens.css`)).status).toBe(200);
    expect((await artboard(`/c/${capability}/project-styles/${project.id}/tokens.css`)).status).toBe(200);
    expect((await artboard(`/c/${capability}/__redline/bridge.js`)).status).toBe(200);
    expect((await artboard(`/__redline/bridge.js`)).status).toBe(404);
    expect((await artboard(`/c/${capability}/pages/${page.id}/assets/logo.svg`)).status).toBe(200);
  });

  it("never serves another project's files with a capability", async () => {
    await start();
    const mine = await createProject();
    const theirs = await createProject();
    const theirPage = await createPage(theirs);
    const capability = await capabilityOf(mine);

    expect((await artboard(`/c/${capability}/pages/${theirPage.id}/a.html`)).status).toBe(403);
    expect((await artboard(`/c/${capability}/project-styles/${theirs.id}/tokens.css`)).status).toBe(403);
    expect((await artboard(`/c/${capability}/page-versions/${theirPage.id}/v/a.html`)).status).toBe(403);
  });

  it("serves a design system to the projects that use it, and to none else", async () => {
    await start();
    const ds = await createDesignSystem();
    const user = await createProject(ds.id);
    const stranger = await createProject();
    expect((await artboard(`/c/${await capabilityOf(user)}/design-systems/${ds.id}/tokens.css`)).status).toBe(200);
    expect((await artboard(`/c/${await capabilityOf(stranger)}/design-systems/${ds.id}/tokens.css`)).status).toBe(403);
    // The design system's own pages open with the design system's capability.
    const dsPage = (await (await api(`/api/projects/${ds.id}/pages`, { title: "Buttons", files: { "a.html": html } })).json()) as Page;
    expect((await artboard(`/c/${await capabilityOf(ds)}/pages/${dsPage.id}/a.html`)).status).toBe(200);
  });

  it("refuses a forged, truncated or expired capability", async () => {
    await start({ artboardCapabilityLifetimeMs: 400 });
    const project = await createProject();
    const page = await createPage(project);
    const issued = (await (await api(`/api/projects/${project.id}/artboard-capability`)).json()) as ArtboardCapability;
    const path = (capability: string) => `/c/${capability}/pages/${page.id}/a.html`;

    expect(issued.renewAfterMs).toBe(200);
    expect((await artboard(path(issued.capability))).status).toBe(200);
    const [payload] = issued.capability.split(".");
    expect((await artboard(path(`${payload}.AAAA`))).status).toBe(403);
    expect((await artboard(path(payload!))).status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await artboard(path(issued.capability))).status).toBe(403);
    // A fresh one works again.
    expect((await artboard(path(await capabilityOf(project)))).status).toBe(200);
  });

  it("still asks for the proxy secret, and survives a restart with the same key", async () => {
    await start();
    const project = await createProject();
    const page = await createPage(project);
    const capability = await capabilityOf(project);
    expect((await fetch(`${server!.artboardOrigin}/c/${capability}/pages/${page.id}/a.html`)).status).toBe(403);
    await server!.close();
    await start();
    expect((await artboard(`/c/${capability}/pages/${page.id}/a.html`)).status).toBe(200);
  });

  it("is not enforced in mode none, which keeps serving plain urls", async () => {
    await start({ authMode: "none", proxySecrets: undefined });
    const project = (await (await fetch(`${server!.url}/api/projects`, { method: "POST", headers: json, body: JSON.stringify({ title: "P" }) })).json()) as Project;
    const page = (await (await fetch(`${server!.url}/api/projects/${project.id}/pages`, { method: "POST", headers: json, body: JSON.stringify({ title: "F", files: { "a.html": html } }) })).json()) as Page;
    const plain = await fetch(`${server!.artboardOrigin}/pages/${page.id}/a.html`);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain("/__redline/bridge.js");
  });

  it("issues nothing to someone the access module refuses", async () => {
    await start({ authMode: "local", proxySecrets: undefined });
    const response = await fetch(`${server!.url}/api/projects/any/artboard-capability`);
    expect(response.status).toBe(401);
  });
});
