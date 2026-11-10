import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORE_TOKENS,
  type DesignMdVersion,
  type DesignSystem,
  type Page,
  type Project,
  type ProjectDesignSystem,
  type ServerEvent,
} from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
const tokensCss = (primary: string, extra = "") =>
  `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#111111"};`).join("\n")}\n${extra}}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

describe("project Design system page and overview box", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const createDesignSystem = async (extra = "") =>
    (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: {
        "tokens.css": tokensCss("#111111", extra),
        "manifest.json": manifestOf(["components/post-cta.html"]),
        "components/post-cta.html": component(".cta{color:red}"),
      },
    })).json()) as DesignSystem;
  const createProject = async (designSystem?: string) => (await (await server.post("/api/projects", { title: "Halloween", designSystem })).json()) as Project;
  const createPage = async (project: Project, files: Record<string, string> = { "a.html": html }) =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Stories", files })).json()) as Page;
  const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;
  const send = (method: "PUT" | "DELETE", project: Project, name: string, body?: object) =>
    fetch(`${server.url}/api/projects/${project.id}/project-style/tokens/${name}`, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  const versions = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/project-style/versions`)).json()) as DesignMdVersion[];
  const token = (d: ProjectDesignSystem, name: string) => d.tokens.find((t) => t.name === name)!;

  it("lists the design system tokens inherited by a project, with its current diffusion", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const d = await detail(project);
    expect(d.designSystem).toEqual({ id: ds.id, title: "Acme DS" });
    expect(d.diffusion?.number).toBe(1);
    expect(d.tokens.map((t) => t.name)).toEqual(CORE_TOKENS);
    expect(token(d, "--color-primary")).toMatchObject({ designSystemValue: "#111111", projectValue: null, value: "#111111", isColor: true, core: true, status: "inherited" });
    expect(d.overrideCount).toBe(0);
    expect(d.lastModified).toBeNull();
  });

  it("sets an override as a user version, then resets it with a new version", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);

    expect((await send("PUT", project, "--color-primary", { value: "#8b5cf6" })).status).toBe(200);
    let d = await detail(project);
    expect(token(d, "--color-primary")).toMatchObject({ designSystemValue: "#111111", projectValue: "#8b5cf6", value: "#8b5cf6", status: "overridden" });
    expect(d.overrideCount).toBe(1);
    expect(d.lastModified?.origin).toBe("user");

    await send("PUT", project, "--color-primary", { value: "#7c3aed" });
    expect(token(await detail(project), "--color-primary").projectValue).toBe("#7c3aed");

    expect((await send("DELETE", project, "--color-primary")).status).toBe(200);
    d = await detail(project);
    expect(token(d, "--color-primary")).toMatchObject({ projectValue: null, value: "#111111", status: "inherited" });
    expect(d.overrideCount).toBe(0);
    expect((await versions(project)).map((v) => v.origin)).toEqual(["user", "user", "user"]);
  });

  it("refuses a value that would break the style, an unset token and the project of a design system", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    expect((await send("PUT", project, "--color-primary", { value: "red; } body { display: none" })).status).toBe(400);
    expect((await send("PUT", project, "color-primary", { value: "red" })).status).toBe(400);
    expect((await send("DELETE", project, "--color-primary")).status).toBe(404);
    expect((await server.get(`/api/projects/${ds.id}/design-system`)).status).toBe(404);
    expect((await send("PUT", { id: ds.id } as Project, "--color-primary", { value: "red" })).status).toBe(404);
  });

  it("counts overrides against the current diffusion, so a draft token is new until it is diffused", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    await send("PUT", project, "--color-primary", { value: "#8b5cf6" });
    await send("PUT", project, "--halloween-glow", { value: "orange" });
    let d = await detail(project);
    expect(token(d, "--halloween-glow")).toMatchObject({ designSystemValue: null, projectValue: "orange", status: "new" });
    expect(d.tokens.at(-1)!.name).toBe("--halloween-glow");
    expect(d.overrideCount).toBe(1);

    // The design system adds the token in its draft: nothing changes until a diffusion.
    const dsPage = (await (await server.get(`/api/projects/${ds.id}/pages`)).json() as Page[])[0]!;
    await server.post(`/api/pages/${dsPage.id}/versions`, { files: { "tokens.css": tokensCss("#111111", "  --halloween-glow: red;\n") }, message: "m", origin: "thread" });
    expect((await detail(project)).overrideCount).toBe(1);
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    d = await detail(project);
    expect(token(d, "--halloween-glow")).toMatchObject({ designSystemValue: "red", status: "overridden" });
    expect(d.overrideCount).toBe(2);
  });

  it("lists the project's own components with their page", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    await createPage(project, {
      "manifest.json": manifestOf(["components/sticker.html"]),
      "components/sticker.html": component(".s{}"),
    });
    const d = await detail(project);
    expect(d.components.map((c) => [c.name, c.page.title, c.file])).toEqual([["sticker", "Stories", "components/sticker.html"]]);
  });

  it("serves a project without a shared design system as its own style", async () => {
    const project = await createProject();
    const d = await detail(project);
    expect(d.designSystem).toBeNull();
    expect(d.diffusion).toBeNull();
    expect(d.overrideCount).toBe(0);

    await send("PUT", project, "--color-primary", { value: "#ff7a00" });
    expect(token(await detail(project), "--color-primary")).toMatchObject({ designSystemValue: null, projectValue: "#ff7a00", status: "own", core: true });
    expect(token(await detail(project), "--color-primary").value).toBe("#ff7a00");
  });

  it("flags a deprecated alias with its replacement", async () => {
    const ds = await createDesignSystem("  --color-accent: var(--color-primary); /* deprecated: renamed to --color-highlight */\n");
    const project = await createProject(ds.id);
    expect(token(await detail(project), "--color-accent").deprecatedFor).toBe("--color-highlight");
  });

  describe("open pages reload when the project style or components change", () => {
    async function collectEvents(): Promise<{ events: () => ServerEvent[]; stop: () => void }> {
      const controller = new AbortController();
      const res = await fetch(`${server.url}/api/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      let text = "";
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            text += new TextDecoder().decode(value);
          }
        } catch {
          // aborted
        }
      })();
      const events = () => text.split("\n\n").flatMap((frame) => (frame.startsWith("data: ") ? [JSON.parse(frame.slice(6)) as ServerEvent] : []));
      return { events, stop: () => controller.abort() };
    }
    const updates = (events: ServerEvent[]) => events.filter((e) => e.type === "design-system-updated");
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    };

    it("announces a token edit to the pages of the project", async () => {
      const ds = await createDesignSystem();
      const project = await createProject(ds.id);
      const page = await createPage(project);
      const feed = await collectEvents();
      await send("PUT", project, "--color-primary", { value: "#8b5cf6" });
      await waitFor(() => updates(feed.events()).length > 0);
      expect(updates(feed.events())).toContainEqual({ type: "design-system-updated", designSystemId: ds.id, pageIds: [page.id] });
      feed.stop();
    });

    it("announces a project component change to the other pages of the project", async () => {
      const project = await createProject();
      const first = await createPage(project);
      const second = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Other", files: { "b.html": html } })).json()) as Page;
      const feed = await collectEvents();
      await server.post(`/api/pages/${first.id}/versions`, {
        files: { "a.html": html, "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component(".s{color:red}") },
        message: "m",
        origin: "thread",
      });
      await waitFor(() => updates(feed.events()).some((e) => e.pageIds.includes(second.id)));
      expect(updates(feed.events()).some((e) => e.pageIds.includes(second.id))).toBe(true);
      feed.stop();
    });
  });
});
