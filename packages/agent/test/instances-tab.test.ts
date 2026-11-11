import { describe, expect, it } from "vitest";
import { runAgentsScreen, type InstancesPort, type ScreenHost, type ScreenTerminal } from "../src/agents-screen.js";
import { SetupRefusal } from "../src/installations.js";
import { initialState, onKey, render, type ScreenCommand, type ScreenState } from "../src/agents-view.js";
import { plainText } from "../src/terminal-draw.js";
import { instanceActionDone, instanceInspected } from "../src/instances-tab.js";
import type { InstanceDetails } from "../src/instance-details.js";
import type { InstanceEntry } from "../src/instance-list.js";

const HOME = "/Users/vincent";
const entry = (id: string, name: string, version: string, address = `redline.${id}.fr`): InstanceEntry => ({ id, name, serverUrl: `https://${address}`, version, tooOld: false });
const lumora = entry("lumora", "Lumora", "0.2.0", "redline.lumora.com");
const brightco = entry("brightco", "Brightco", "0.1.0");
const tests = entry("tests", "Tests", "0.3.0");
const local = entry("local", "Local", "0.3.0");
const acme = entry("acme", "Acme", "0.2.1");
const instances = [local, acme, tests, brightco, lumora];

const details = (over: Partial<InstanceDetails> & Pick<InstanceDetails, "diagnosis">): InstanceDetails => ({ dir: `${HOME}/.config/redline/instances/x`, agents: [], folders: [], sessions: 0, ...over });
const upToDate = details({ diagnosis: { state: "up-to-date", severity: "ok", status: "v0.2.1 · up to date · token OK" } });
const updateAvailable = details({
  installedVersion: "0.2.0",
  serverVersion: "0.2.1",
  dir: `${HOME}/.config/redline/instances/lumora`,
  agents: ["agora", "lumora-site"],
  folders: [`${HOME}/claude-projects/agora`, `${HOME}/lumora`],
  sessions: 2,
  diagnosis: { state: "update-available", severity: "warning", status: "v0.2.0 installed, the server runs v0.2.1", fix: { before: "", command: "redline update lumora" } },
});
const tooOld = details({
  installedVersion: "0.1.0",
  serverVersion: "0.3.0",
  diagnosis: { state: "too-old", severity: "problem", status: "v0.1.0, too old for this command (accepts v0.2.0 and later)", fix: { before: "", command: "redline update brightco" } },
});
const unreachable = details({ diagnosis: { state: "unreachable", severity: "problem", status: "cannot reach the server", fix: { before: "check the address, or ", command: "redline remove tests" } } });
const refused = details({ diagnosis: { state: "token-refused", severity: "problem", status: "token refused (regenerated, or account deactivated)", fix: { before: "copy your token from Acme's Agents page (Lancer un agent), then ", command: "redline setup https://redline.acme.fr" } } });

function open(entries = instances, loaded: Record<string, InstanceDetails> = {}): ScreenState {
  let state = initialState({ agents: [], now: 0, home: HOME, folder: `${HOME}/claude-projects/agora`, instances: entries, folderLine: { kind: "linked", instance: "Lumora", project: "Agora" }, tab: "instances" });
  for (const [id, loadedDetails] of Object.entries(loaded)) state = instanceInspected(state, id, loadedDetails);
  return state;
}
const all = { lumora: updateAvailable, brightco: tooOld, tests: unreachable, local: upToDate, acme: upToDate };
const text = (state: ScreenState, columns = 120, rows = 30) => plainText(render(state, { columns, rows })).join("\n");
const frame = (state: ScreenState, columns = 120, rows = 30) => plainText(render(state, { columns, rows }));
const press = (state: ScreenState, ...keys: string[]) => keys.reduce((s, k) => onKey(s, k).state, state);
const commandsOf = (state: ScreenState, key: string): ScreenCommand[] => onKey(state, key).commands;

describe("the Instances tab", () => {
  it("lists the problems first, then the up to date ones, each with its version and state", () => {
    const rows = frame(open(instances, all)).map((line) => line.split("│")[1] ?? "");
    const listed = rows.filter((row) => /v\d/.test(row)).map((row) => row.replace(/\s+/g, " ").trim());
    expect(listed).toEqual(["▎ › ! Lumora v0.2.0 update available", "✗ Brightco v0.1.0 too old", "✗ Tests v0.3.0 unreachable", "✓ Local v0.3.0 up to date", "✓ Acme v0.2.1 up to date"]);
    expect(rows[6].trim()).toBe("problems first");
  });

  it("counts the problems on the tab, in the header and in the tab bar", () => {
    const shown = frame(open(instances, all));
    expect(shown[1]).toMatch(/redline {2}Lumora · redline\.lumora\.com +5 instances · 3 problems {2}$/);
    expect(shown[4]).toMatch(/^ {2} Agents {2}0 {4} Instances {2}5 ! 3 {4} Comments {2}0 /);
  });

  it("shows the doctor of the selected installation on the left, as the mock-up does", () => {
    const shown = frame(open(instances, all)).map((line) => line.split("│")[0].replace(/\s+$/, ""));
    expect(shown.slice(8, 18)).toEqual([
      "  Installed  v0.2.0 · ~/.config/redline/instances/lumora",
      "  Server     v0.2.1",
      "  Token      OK",
      "  Agents     agora, lumora-site",
      "  Folders    ~/claude-projects/agora, ~/lumora",
      "  Sessions   2 Claude Code sessions use it",
      expect.stringMatching(/^─+┤/),
      "  WHAT TO DO",
      "  u installs v0.2.1. agora and lumora-site restart, each after its run;",
      "  the 2 sessions then need /mcp and reconnect redline.",
    ]);
    expect(shown[7]).toMatch(/^ {2}Lumora {2}redline\.lumora\.com +! update available$/);
    expect(shown[14]).toMatch(/^─+┤/);
    expect(shown[18]).toBe("");
    expect(shown[19]).toBe("  x removes it (refused while an agent or a session uses it).");
  });

  it("shows loading per installation until its diagnosis arrives, and keeps the screen usable", () => {
    const state = open(instances, { local: upToDate });
    const shown = text(press(state, "down"));
    expect(shown).toMatch(/… Acme +v0\.2\.1 +checking/);
    expect(shown).toMatch(/✓ Local +v0\.3\.0 +up to date/);
    expect(shown).toContain("Checking the server");
    expect(commandsOf(press(state, "down"), "u")).toEqual([]);
    expect(commandsOf(press(state, "down"), "x")).toEqual([]);
  });

  it("moves the selection with ↑↓ over the sorted list, and the detail follows", () => {
    const state = open(instances, all);
    const down = press(state, "down");
    expect(text(down)).toContain("› ✗ Brightco");
    expect(text(down, 140)).toContain("Status     v0.1.0, too old for this command (accepts v0.2.0 and later)");
    expect(text(down)).toContain("→ redline update brightco");
    expect(text(press(down, "up", "up"))).toContain("› ! Lumora");
  });

  it("uses doctor's texts for the other states", () => {
    const withRefused = open([...instances, entry("acme2", "Acme2", "0.2.1")], { ...all, acme2: refused });
    const shown = text(press(withRefused, "down", "down"), 160);
    expect(shown).toContain("› ✗ Acme2");
    expect(shown).toContain("Token      refused (regenerated, or account deactivated)");
    expect(shown).toContain("→ copy your token from Acme's Agents page (Lancer un agent), then redline setup https://redline.acme.fr");
    const unreachableShown = text(press(open(instances, all), "down", "down"), 160);
    expect(unreachableShown).toContain("Token      not checked: the server cannot be reached");
    expect(unreachableShown).toContain("→ check the address, or redline remove tests");
    const fine = text(press(open(instances, all), "down", "down", "down"));
    expect(fine).toContain("Nothing to do: up to date.");
  });

  it("asks to update or remove the selected installation, once its diagnosis is known", () => {
    const state = open(instances, all);
    expect(commandsOf(state, "u")).toEqual([{ type: "update-instance", id: "lumora" }]);
    expect(commandsOf(state, "x")).toEqual([{ type: "remove-instance", id: "lumora" }]);
    expect(text(onKey(state, "u").state)).toContain("Updating Lumora");
    expect(commandsOf(onKey(state, "u").state, "x")).toEqual([]);
  });

  it("shows the result of an update, then checks the installation again", () => {
    const busy = onKey(open(instances, all), "u").state;
    const done = instanceActionDone(busy, "lumora", { ok: true, version: "0.2.1", lines: ["Lumora: v0.2.0 → v0.2.1 (redline.lumora.com)", "✓ Installed. Agents restarted, each after its run: agora."] });
    expect(text(done)).toContain("✓ Installed. Agents restarted, each after its run: agora.");
    expect(text(done)).toMatch(/… Lumora +v0\.2\.1 +checking/);
  });

  it("shows a refusal in the screen", () => {
    const busy = onKey(open(instances, all), "x").state;
    const refusedRemoval = instanceActionDone(busy, "lumora", { ok: false, lines: ["Agents of Lumora are running (agora). Stop them first: redline, then x."] });
    expect(text(refusedRemoval, 140)).toContain("✗ Agents of Lumora are running (agora). Stop them first: redline, then x.");
    expect(text(refusedRemoval)).toContain("› ! Lumora");
    expect(commandsOf(refusedRemoval, "x")).toEqual([{ type: "remove-instance", id: "lumora" }]);
    expect(text(press(refusedRemoval, "down"))).not.toContain("Stop them first");
  });

  it("drops a removed installation from the list and the counts", () => {
    const busy = onKey(open(instances, all), "x").state;
    const done = instanceActionDone(busy, "lumora", { ok: true, lines: ["✓ Removed Lumora (~/.config/redline/instances/lumora)."], removed: true });
    const shown = text(done);
    expect(shown).not.toMatch(/! Lumora/);
    expect(shown).toContain("✓ Removed Lumora");
    expect(shown).toMatch(/4 instances · 2 problems/);
    expect(done.instances.map((e) => e.id)).not.toContain("lumora");
  });

  it("says when no installation is set up", () => {
    expect(text(open([]))).toContain("No instance is set up on this computer. Press s to set one up.");
  });

  it("s closes the screen to run the setup", () => {
    const update = onKey(open(instances, all), "s");
    expect(update.commands).toEqual([{ type: "close" }]);
    expect(update.state.instancesTab.setupAfter).toBe(true);
  });

  it("scrolls the detail with ↑↓ when it has the focus", () => {
    const state = open(instances, all);
    const left = press(state, "left");
    expect(text(left)).toContain("▎ WHAT TO DO  ↑↓ scroll · → back to the list");
    const short = text(left, 120, 17);
    expect(short).not.toContain("x removes it");
    expect(text(press(left, ...Array(12).fill("down")), 120, 17)).toContain("x removes it");
    expect(text(press(left, "down"))).toContain("› ! Lumora");
  });

  it("windows a long list around the selection with how many are above and below", () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`i${String(i + 1).padStart(2, "0")}`, `Inst${String(i + 1).padStart(2, "0")}`, "0.2.1"));
    const everyone = Object.fromEntries(many.map((e) => [e.id, upToDate]));
    const top = text(open(many, everyone));
    expect(top).toMatch(/│ {2}↓ \d+ more/);
    const bottom = text(press(open(many, everyone), ...Array(11).fill("down")));
    expect(bottom).toMatch(/│ {2}↑ \d+ more/);
    expect(bottom).toContain("› ✓ Inst12");
    expect(bottom).not.toMatch(/│ {2}↓/);
  });

  it("shows the keys on the bar", () => {
    const bar = frame(open(instances, all)).at(-1)!;
    expect(bar).toMatch(/↑↓ +instance +u +update +x +remove +s +setup another +\? +commands +Tab +next tab +q +close/);
  });
});

describe("the Instances tab over the screen runner", () => {
  const host: ScreenHost = {
    snapshot: async () => ({ agents: [] }),
    log: async () => [],
    subscribe: async () => undefined,
    stop: async () => undefined,
    remove: async () => undefined,
    restart: async () => undefined,
    restartAll: async () => undefined,
    setModelEffort: async () => undefined,
  } as unknown as ScreenHost;

  class Terminal implements ScreenTerminal {
    frames: string[][] = [];
    keyListener: (key: string) => void = () => undefined;
    size() { return { columns: 120, rows: 30 }; }
    draw(lines: string[]) { this.frames.push(lines); }
    onKey(listener: (key: string) => void) { this.keyListener = listener; }
    onResize() {}
    close() {}
    get frame() { return plainText(this.frames.at(-1)!).join("\n"); }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const start = async (instancesPort: InstancesPort, entries = [lumora, brightco]) => {
    const terminal = new Terminal();
    const done = runAgentsScreen({ host, terminal, home: HOME, folder: HOME, instances: entries, folderLine: { kind: "unlinked" }, linkFolder: async () => ({ kind: "unlinked" }), newAgent: {} as never, instancesPort, openUrl: () => undefined, tickMs: 1_000_000 });
    await settle();
    terminal.keyListener("2");
    return { terminal, done };
  };

  it("shows each installation as checking until its own answer arrives, and stays responsive meanwhile", async () => {
    const release: Record<string, (details: InstanceDetails) => void> = {};
    const { terminal, done } = await start({
      inspect: (id) => new Promise((resolve) => (release[id] = resolve)),
      update: async () => ({ lines: [] }),
      remove: async () => [],
    });
    expect(terminal.frame).toMatch(/… Lumora +v0\.2\.0 +checking/);
    expect(terminal.frame).toMatch(/… Brightco +v0\.1\.0 +checking/);
    terminal.keyListener("down");
    expect(terminal.frame).toContain("› … Brightco");
    release.brightco(tooOld);
    await settle();
    expect(terminal.frame).toMatch(/✗ Brightco +v0\.1\.0 +too old/);
    expect(terminal.frame).toMatch(/… Lumora +v0\.2\.0 +checking/);
    terminal.keyListener("q");
    await done;
  });

  it("updates through the port, shows the result and checks the installation again; a refusal is shown, not thrown", async () => {
    const inspected: string[] = [];
    let refuse = false;
    const { terminal, done } = await start({
      inspect: async (id) => (inspected.push(id), id === "lumora" ? updateAvailable : tooOld),
      update: async () => {
        if (refuse) throw new SetupRefusal("Could not update Lumora: npm failed.\n  Nothing was changed.");
        return { lines: ["Lumora: v0.2.0 → v0.2.1 (redline.lumora.com)", "✓ Installed."], version: "0.2.1" };
      },
      remove: async () => {
        throw new SetupRefusal("Agents of Lumora are running (agora). Stop them first: redline, then x.");
      },
    });
    await settle();
    terminal.keyListener("u");
    expect(terminal.frame).toContain("Updating Lumora");
    await settle();
    expect(terminal.frame).toContain("✓ Installed.");
    expect(inspected.filter((id) => id === "lumora")).toHaveLength(2);
    refuse = true;
    terminal.keyListener("x");
    await settle();
    expect(terminal.frame).toContain("✗ Agents of Lumora are running (agora).");
    terminal.keyListener("q");
    await done;
  });
});
