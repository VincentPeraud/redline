import { commentsLoaded } from "./comments-tab.js";
import type { CommentsResult } from "./comments-source.js";
import { agentStarted, applyEvent, folderLinked, initialState, logLoaded, newAgentFailed, newAgentQuestions, onKey, projectsLoaded, render, tick, type ScreenCommand, type ScreenState, type Size } from "./agents-view.js";
import type { HostClient } from "./host-client.js";
import type { FolderLine, InstanceEntry } from "./instance-list.js";
import { instanceActionDone, instanceInspected, type InstanceAction } from "./instances-tab.js";
import { SetupRefusal } from "./installations.js";
import type { InstanceDetails } from "./instance-details.js";
import type { NewAgentFlow } from "./new-agent.js";

/** What the screen needs from the agent host: a `HostClient` provides it, tests give a fake. Later tickets add their commands here. */
export type ScreenHost = Pick<HostClient, "snapshot" | "log" | "subscribe" | "stop" | "remove" | "restart" | "restartAll" | "setModelEffort">;

/** The terminal, as the screen sees it: the driver implements it on stdin/stdout, tests record frames. */
export interface ScreenTerminal {
  size(): Size;
  draw(lines: string[]): void;
  /** Keys as `onKey` of the view reads them: "up", "down", "ctrl-c", or the character typed. */
  onKey(listener: (key: string) => void): void;
  onResize(listener: () => void): void;
  /** Restores the terminal. Called once, whatever the way out. */
  close(): void;
}

/** What the Instances tab does with an installation; the CLI wires doctor, `redline update` and `redline remove` (refusals reject with `SetupRefusal`). */
export interface InstancesPort {
  inspect(id: string): Promise<InstanceDetails>;
  /** The lines `redline update` prints, and the version now installed. */
  update(id: string): Promise<{ lines: string[]; version?: string }>;
  /** The lines `redline remove` prints. */
  remove(id: string): Promise<string[]>;
}

export interface AgentsScreenOptions {
  host: ScreenHost;
  terminal: ScreenTerminal;
  /** The agent to open on; the first one by default. */
  selectedId?: string;
  now?: () => number;
  home: string;
  /** The folder the screen was opened from, for `n`. */
  folder: string;
  /** The installations on this computer, and what the folder uses (the resolver's answer). */
  instances: InstanceEntry[];
  folderLine: FolderLine;
  /** Links the folder to the instance at that address (`l`, as `redline link`); resolves with the new "This folder" line. */
  linkFolder(serverUrl: string): Promise<FolderLine>;
  /** Reads the comments waiting for terminal sessions (Comments tab); called at the start, then every `commentsRefreshMs`. Without it the tab stays empty. */
  comments?: () => Promise<CommentsResult>;
  commentsRefreshMs?: number;
  /** Starts an agent for the folder (`n`). */
  newAgent: NewAgentFlow;
  /** The Instances tab's diagnoses and actions; without it the installations stay "checking". */
  instancesPort?: InstancesPort;
  /** Opens an address in the user's browser (`o`). */
  openUrl(url: string): void;
  /** How often the clock (uptimes, the time of a run in progress) advances. Default 1 s; a frame that did not change is not drawn again. */
  tickMs?: number;
}

function execute(host: ScreenHost, command: ScreenCommand): Promise<unknown> {
  switch (command.type) {
    case "stop":
      return host.stop(command.agentId);
    case "remove":
      return host.remove(command.agentId);
    case "restart":
      return host.restart(command.agentId);
    case "restart-all":
      return host.restartAll();
    case "set-model-effort":
      return host.setModelEffort(command.agentId, { model: command.model, effort: command.effort });
    case "link-folder":
    case "inspect-instance":
    case "update-instance":
    case "remove-instance":
    case "close":
    case "open":
    case "prepare-new":
    case "list-projects":
    case "start-new":
      return Promise.resolve();
  }
}

/** Runs the agents screen until the user closes it; resolves with the final state (for `closeSummary`). The terminal is restored on any outcome. */
export async function runAgentsScreen({ host, terminal, selectedId, now = Date.now, home, folder, instances, folderLine, linkFolder, newAgent, instancesPort, openUrl, tickMs = 1000, comments, commentsRefreshMs = 20_000 }: AgentsScreenOptions): Promise<ScreenState> {
  let timer: NodeJS.Timeout | undefined;
  let commentsTimer: NodeJS.Timeout | undefined;
  try {
    let state = initialState({ agents: [], now: now(), home, folder, instances, folderLine });
    let drawn: string[] = [];
    const draw = (onlyIfChanged = false) => {
      const lines = render(state, terminal.size());
      if (onlyIfChanged && lines.length === drawn.length && lines.every((line, index) => line === drawn[index])) return;
      drawn = lines;
      terminal.draw(lines);
    };
    /** The questions of the `n` dialog run apart from the host: their failures are shown in the dialog, not fatal to the screen. */
    const askNewAgent = (command: ScreenCommand) => {
      const show = (change: (current: ScreenState) => ScreenState) => {
        state = change(state);
        draw();
      };
      const failed = (error: Error) => show((current) => newAgentFailed(current, error.message));
      if (command.type === "prepare-new") newAgent.inspect().then((questions) => show((current) => newAgentQuestions(current, questions)), failed);
      else if (command.type === "list-projects") newAgent.projectsOf(command.serverUrl).then((projects) => show((current) => projectsLoaded(current, command.serverUrl, projects)), failed);
      else if (command.type === "start-new") newAgent.start(command.answers).then((agent) => show((current) => agentStarted(current, agent.id)), failed);
    };
    /** Each installation's diagnosis is gathered apart, so that the screen answers keys meanwhile; the first to arrive shows first. */
    const inspect = (id: string, reject: (error: Error) => void) => {
      instancesPort?.inspect(id).then((details) => {
        if (!state.instances.some((entry) => entry.id === id)) return;
        state = instanceInspected(state, id, details);
        draw();
      }, reject);
    };
    /** An update or a removal: its refusal is shown in the screen, any other failure ends it. */
    const act = (command: ScreenCommand, reject: (error: Error) => void) => {
      if (!instancesPort || (command.type !== "update-instance" && command.type !== "remove-instance")) return;
      const { id } = command;
      const done: Promise<InstanceAction> = command.type === "update-instance" ? instancesPort.update(id).then(({ lines, version }) => ({ ok: true, lines, version })) : instancesPort.remove(id).then((lines) => ({ ok: true, lines, removed: true }));
      done.then(
        (action) => {
          state = instanceActionDone(state, id, action);
          draw();
          if (!action.removed) inspect(id, reject);
        },
        (error: Error) => {
          if (!(error instanceof SetupRefusal)) return reject(error);
          state = instanceActionDone(state, id, { ok: false, lines: error.message.split("\n").map((line) => line.trim()).filter(Boolean) });
          draw();
        },
      );
    };
    const loadLog = (agentId: string) =>
      host.log(agentId).then((entries) => {
        state = logLoaded(state, agentId, entries);
        draw();
      });
    // Subscribing first: a change between the list and the subscription would be lost the other way round.
    await host.subscribe((event) => {
      state = applyEvent(state, event);
      if (event.event === "agent-added") void loadLog(event.agent.id);
      draw();
    });
    const { agents, freshStartAt } = await host.snapshot();
    state = initialState({ agents, selectedId, now: now(), home, folder, freshStartAt, instances, folderLine });
    await Promise.all(agents.map((agent) => loadLog(agent.id)));

    return await new Promise<ScreenState>((resolve, reject) => {
      for (const instance of state.instances) inspect(instance.id, reject);
      terminal.onKey((key) => {
        const update = onKey(state, key);
        state = update.state;
        if (update.commands.some((command) => command.type === "close")) resolve(state);
        else draw();
        // The host reports the effect of a command as events; a failing host ends the screen like any other host failure.
        for (const command of update.commands) {
          if (command.type === "open") openUrl(command.url);
          if (command.type === "link-folder") {
            linkFolder(command.serverUrl).then((line) => {
              state = folderLinked(state, line);
              draw();
            }, reject);
          }
          askNewAgent(command);
          act(command, reject);
          execute(host, command).catch(reject);
        }
      });
      terminal.onResize(() => draw());
      if (comments) {
        // A failed read shows as a failure of the tab, never as the end of the screen; reads do not overlap.
        let reading = false;
        const refresh = () => {
          if (reading) return;
          reading = true;
          comments()
            .then((result) => (state = commentsLoaded(state, result)), (error: Error) => (state = commentsLoaded(state, { entries: [], failures: [{ instance: "Redline", message: error.message }] })))
            .finally(() => {
              reading = false;
              draw();
            });
        };
        refresh();
        commentsTimer = setInterval(refresh, commentsRefreshMs);
      }
      timer = setInterval(() => {
        state = tick(state, now());
        draw(true);
      }, tickMs);
      draw();
    });
  } finally {
    clearInterval(timer);
    clearInterval(commentsTimer);
    terminal.close();
  }
}
