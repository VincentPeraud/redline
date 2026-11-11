import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orphanLines, runLink } from "../src/link-command.js";
import { resolveFolder } from "../src/installations.js";
import { addInstallation, fakeWorld, folderWithLink, tempDir } from "./support/installations.js";

/** A computer with Local, Lumora and Brightco, and a terminal that answers what it is given. */
function terminal(answers: string[] = [], names: Record<string, string[]> = {}) {
  const configDir = tempDir();
  const world = fakeWorld();
  const installed = [
    addInstallation(configDir, { name: "Local", serverUrl: "https://redline.localhost", version: "0.3.0" }),
    addInstallation(configDir, { name: "Lumora", serverUrl: "https://redline.lumora.com", version: "0.2.0" }),
    addInstallation(configDir, { name: "Brightco", serverUrl: "https://redline.brightco.fr", version: "0.1.0" }),
  ];
  const out: string[] = [];
  const questions: string[] = [];
  const run = (folder: string, wanted?: string) => {
    return runLink({
      configDir,
      folder,
      wanted,
      home: "/home/me",
      fetchInstance: world.deps.fetchInstance,
      projectNames: async (_installation, ids) => ids.flatMap((id) => names[id] ?? []),
      ask: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      },
      out: (line) => out.push(line),
    });
  };
  return { configDir, run, out, questions };
}

const linkOf = (folder: string) => JSON.parse(readFileSync(join(folder, ".redline", "project.json"), "utf8")) as { serverUrl: string; projectIds: string[] };

describe("redline link", () => {
  it("lists the instances, asks, and links the folder without project", async () => {
    const { run, out, configDir } = terminal(["1"]);
    const folder = folderWithLink();
    await run(folder);
    expect(out).toEqual([
      "  1. Brightco  redline.brightco.fr   v0.1.0",
      "  2. Local     redline.localhost     v0.3.0",
      "  3. Lumora    redline.lumora.com    v0.2.0",
      `✓ ${folder} linked to Brightco (redline.brightco.fr). No agent started.`,
      "  Open Claude Code sessions here: type /mcp and reconnect redline.",
    ]);
    expect(linkOf(folder)).toEqual({ serverUrl: "https://redline.brightco.fr", projectIds: [] });
    expect(resolveFolder(configDir, folder)).toMatchObject({ kind: "linked", installation: { id: "brightco" } });
  });

  it("takes the instance named on the command line, by name or address", async () => {
    const { run, out } = terminal();
    const folder = folderWithLink();
    await run(folder, "lumora");
    expect(linkOf(folder).serverUrl).toBe("https://redline.lumora.com");
    expect(out[0]).toContain("linked to Lumora (redline.lumora.com)");
    await run(folderWithLink(), "https://redline.localhost");
  });

  it("refuses an instance that is not installed, listing the ones that are", async () => {
    const { run } = terminal();
    await expect(run(folderWithLink(), "tda")).rejects.toThrow(/tda is not installed.*Brightco, Local, Lumora/);
  });

  it("takes the only instance without asking", async () => {
    const configDir = tempDir();
    addInstallation(configDir, { name: "Lumora", serverUrl: "https://redline.lumora.com" });
    const out: string[] = [];
    const folder = folderWithLink();
    await runLink({ configDir, folder, home: "/home/me", fetchInstance: async () => ({}), projectNames: async () => [], ask: async () => Promise.reject(new Error("no question expected")), out: (line) => out.push(line) });
    expect(out).toEqual(["✓ Linked to Lumora, the only instance on this computer. No agent started."]);
    expect(linkOf(folder).serverUrl).toBe("https://redline.lumora.com");
  });

  it("asks before switching a linked folder, saying which projects it stops serving, and switches on y", async () => {
    const { run, out, questions } = terminal(["y"], { p1: ["Agora"] });
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: ["p1"] });
    await run(folder, "local");
    expect(out).toEqual(["This folder is linked to Lumora and serves Agora there. Link it to Local instead?", "✓ Linked to Local. No project yet: redline agent picks one."]);
    expect(questions).toEqual(["Its agent stops serving Agora from this folder. (y/N): "]);
    expect(linkOf(folder)).toEqual({ serverUrl: "https://redline.localhost", projectIds: [] });
  });

  it("changes nothing on no, and never rewrites the link", async () => {
    const { run, out } = terminal(["n"], { p1: ["Agora"] });
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: ["p1"] });
    await run(folder, "local");
    expect(out.at(-1)).toBe("Nothing changed.");
    expect(out).not.toContainEqual(expect.stringContaining("✓"));
    expect(linkOf(folder)).toEqual({ serverUrl: "https://redline.lumora.com", projectIds: ["p1"] });
  });

  it("keeps the projects of a folder already linked to the instance asked", async () => {
    const { run, out } = terminal();
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: ["p1"] });
    await run(folder, "lumora");
    expect(out).toEqual(["✓ Already linked to Lumora (redline.lumora.com). Nothing changed."]);
    expect(linkOf(folder).projectIds).toEqual(["p1"]);
  });

  it("asks before replacing a link to an address that is not installed", async () => {
    const { run, out, questions } = terminal(["y"]);
    const folder = folderWithLink({ serverUrl: "https://redline.tda.fr", projectIds: ["p1"] });
    await run(folder, "local");
    expect(out[0]).toBe("This folder is linked to redline.tda.fr, which is not installed on this computer.");
    expect(questions).toEqual(["Link it to Local instead? (y/N): "]);
    expect(linkOf(folder).serverUrl).toBe("https://redline.localhost");
  });

  it("links a subfolder of a linked folder on its own, without asking", async () => {
    const { run } = terminal();
    const root = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: ["p1"] });
    const sub = join(root, "pkg");
    await run(sub, "local");
    expect(linkOf(root).serverUrl).toBe("https://redline.lumora.com");
    expect(linkOf(sub).serverUrl).toBe("https://redline.localhost");
  });
});

describe("the message of redline agent in a folder linked to an address not installed here", () => {
  it("names the address and the setup to run", () => {
    expect(orphanLines("https://redline.tda.fr")).toEqual(["This folder is linked to redline.tda.fr, which is not installed on this computer.", "  Install it: redline setup https://redline.tda.fr"]);
  });
});
