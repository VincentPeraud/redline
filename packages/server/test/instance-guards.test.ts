import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type Project, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;

const componentFile = (template: string) =>
  `<!doctype html><html><head><style data-component>ui-x{display:block}</style></head><body><template data-component>${template}</template></body></html>`;
const MODAL = componentFile(`<div class="modal"><h2><slot name="title"></slot></h2><slot></slot></div>`);
const MODAL_WITHOUT_TITLE_SLOT = componentFile(`<div class="modal"><slot></slot></div>`);

const sizeTweak = (options: string[], fallback: string) => ({ id: "size", type: "choice", label: "Size", options, default: fallback, artboard: "components/modal.html" });
const manifestOf = (files: string[], tweaks: object[] = [], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks });
const modalFiles = (tweaks: object[], modal = MODAL, extra: Record<string, string> = {}, extraArtboards: string[] = []) => ({
  "manifest.json": manifestOf(["components/modal.html", ...extraArtboards], tweaks),
  "components/modal.html": modal,
  ...extra,
});
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("guards on removed settings and slots, changed defaults and rollback", () => {
  let server: TestServer;
  let ds: DesignSystem;

  beforeEach(async () => {
    server = await startTestServer();
    ds = (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: { "tokens.css": tokensCss, ...modalFiles([sizeTweak(["sm", "md", "lg"], "md")]) },
    })).json()) as DesignSystem;
  });
  afterEach(async () => {
    await server.stop();
  });

  const publish = (files: Record<string, string>, extra: object = {}) => server.post(`/api/pages/${ds.pageId}/versions`, { files, message: "Edit", origin: "thread", ...extra });
  const diffuse = () => server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;
  const createProject = async (title: string, designSystem: string | undefined = ds.id) => (await (await server.post("/api/projects", { title, designSystem })).json()) as Project;
  const addPage = async (project: Project, title: string, body: string, extra: Record<string, string> = {}) =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title, files: { "manifest.json": manifestOf(["a.html"], [], project.designSystem ?? undefined), "a.html": mockup(body), ...extra } })).json()) as Page;
  const threadsOf = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];

  it("refuses removing a setting value an instance uses, listing the page, and publishes the removal of an unused one", async () => {
    const project = await createProject("Halloween");
    await addPage(project, "Stories", `<ui-modal size="lg"></ui-modal>`);

    const refused = await publish(modalFiles([sizeTweak(["sm", "md"], "md")]));
    expect(refused.status).toBe(400);
    const message = await error(refused);
    expect(message).toContain('size="lg"');
    expect(message).toContain('page "Stories" of project "Halloween"');

    expect((await publish(modalFiles([sizeTweak(["md", "lg"], "md")]))).status).toBe(201);
  });

  it("refuses removing a slot an instance fills, and lets an unused slot go", async () => {
    const project = await createProject("Halloween");
    await addPage(project, "Stories", `<ui-modal><span slot="title">Hi</span></ui-modal>`);
    const tweaks = [sizeTweak(["sm", "md", "lg"], "md")];

    const refused = await publish(modalFiles(tweaks, MODAL_WITHOUT_TITLE_SLOT));
    expect(refused.status).toBe(400);
    expect(await error(refused)).toContain('slot "title"');

    const other = await createProject("Other");
    await addPage(other, "Plain", `<ui-modal><p>x</p></ui-modal>`);
    expect((await publish(modalFiles(tweaks, MODAL))).status).toBe(201);
  });

  it("counts a use by another component's template and names the component", async () => {
    const tweaks = [sizeTweak(["sm", "md", "lg"], "md")];
    const withDialog = modalFiles(tweaks, MODAL, { "components/dialog.html": componentFile(`<ui-modal size="lg"><slot></slot></ui-modal>`) }, ["components/dialog.html"]);
    expect((await publish(withDialog)).status).toBe(201);

    const refused = await publish({ ...withDialog, "manifest.json": manifestOf(["components/modal.html", "components/dialog.html"], [sizeTweak(["sm", "md"], "md")]) });
    expect(refused.status).toBe(400);
    expect(await error(refused)).toContain('component "dialog"');
  });

  it("leaves out projects that keep their own component of that name", async () => {
    const own = await createProject("Own modal");
    await addPage(own, "Stories", `<ui-modal size="lg"></ui-modal>`, {
      "manifest.json": manifestOf(["a.html", "components/modal.html"], [], ds.id),
      "components/modal.html": componentFile(`<div class="mine"><slot></slot></div>`),
    });
    expect((await publish(modalFiles([sizeTweak(["sm", "md"], "md")]))).status).toBe(201);
  });

  it("lets a confirmed removal through, then opens one Redline thread per affected page at diffusion", async () => {
    const project = await createProject("Halloween");
    const stories = await addPage(project, "Stories", `<ui-modal size="lg"></ui-modal><ui-modal size="lg"></ui-modal>`);
    const planning = await addPage(project, "Planning", `<ui-modal size="lg"></ui-modal>`);
    const unaffected = await addPage(project, "Plain", `<ui-modal size="sm"></ui-modal>`);

    const files = modalFiles([sizeTweak(["sm", "md"], "md")]);
    expect((await publish(files)).status).toBe(400);
    expect((await publish(files, { confirmRemovals: true })).status).toBe(201);
    expect(await threadsOf(stories)).toHaveLength(0);

    expect((await diffuse()).status).toBe(201);
    const threads = [...(await threadsOf(stories)), ...(await threadsOf(planning))];
    expect(threads).toHaveLength(2);
    for (const thread of threads) {
      expect(thread.automatic).toBe(true);
      expect(thread.status).toBe("open");
      expect(thread.body).toContain("lg");
    }
    expect(await threadsOf(unaffected)).toHaveLength(0);
  });

  it("refuses changing a default with the instances that omit the setting and their pages, and opens no thread once confirmed", async () => {
    const project = await createProject("Halloween");
    const stories = await addPage(project, "Stories", `<ui-modal></ui-modal><ui-modal></ui-modal><ui-modal size="sm"></ui-modal>`);
    await addPage(project, "Planning", `<ui-modal></ui-modal>`);
    const files = modalFiles([sizeTweak(["sm", "md", "lg"], "lg")]);

    const refused = await publish(files);
    expect(refused.status).toBe(400);
    const message = await error(refused);
    expect(message).toContain("3 instances without size in 2 pages");
    expect(message).toContain("md");
    expect(message).toContain("lg");
    expect(message).toContain('page "Planning" of project "Halloween"');

    expect((await publish(files, { confirmRemovals: true })).status).toBe(201);
    await diffuse();
    expect(await threadsOf(stories)).toHaveLength(0);
  });

  it("lets a default change through when no instance omits the setting", async () => {
    const project = await createProject("Halloween");
    await addPage(project, "Stories", `<ui-modal size="sm"></ui-modal>`);
    expect((await publish(modalFiles([sizeTweak(["sm", "md", "lg"], "lg")]))).status).toBe(201);
  });

  it("refuses rolling back to a diffusion that lacks a value a page uses, listing the pages", async () => {
    const tweaks = [sizeTweak(["sm", "md", "lg", "xl"], "md")];
    expect((await publish(modalFiles(tweaks))).status).toBe(201);
    expect((await diffuse()).status).toBe(201);
    const project = await createProject("Halloween");
    await addPage(project, "Stories", `<ui-modal size="xl"></ui-modal>`);

    const refused = await server.post(`/api/design-systems/${ds.id}/diffusions/1/rollback`, {});
    expect(refused.status).toBe(409);
    const message = await error(refused);
    expect(message).toContain('size="xl"');
    expect(message).toContain('page "Stories" of project "Halloween"');
  });

  it("rolls back when no page uses what the diffusion lacks", async () => {
    expect((await publish(modalFiles([sizeTweak(["sm", "md", "lg", "xl"], "md")]))).status).toBe(201);
    await diffuse();
    const project = await createProject("Halloween");
    await addPage(project, "Stories", `<ui-modal size="sm"></ui-modal>`);
    expect((await server.post(`/api/design-systems/${ds.id}/diffusions/1/rollback`, {})).status).toBe(201);
  });
});
