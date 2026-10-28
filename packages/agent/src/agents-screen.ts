import { agentStarted, applyEvent, initialState, logLoaded, newAgentFailed, newAgentQuestions, onKey, projectsLoaded, render, tick, type ScreenCommand, type ScreenState, type Size } from "./agents-view.js";
import type { HostClient } from "./host-client.js";
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

export interface AgentsScreenOptions {
  host: ScreenHost;
  terminal: ScreenTerminal;
  /** The agent to open on; the first one by default. */
  selectedId?: string;
  now?: () => number;
  home: string;
  /** The folder the screen was opened from, for `n`. */
  folder: string;
  /** Starts an agent for the folder (`n`). */
  newAgent: NewAgentFlow;
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
    case "close":
    case "open":
    case "prepare-new":
    case "list-projects":
    case "start-new":
      return Promise.resolve();
  }
}

/** Runs the agents screen until the user closes it; resolves with the final state (for `closeSummary`). The terminal is restored on any outcome. */
export async function runAgentsScreen({ host, terminal, selectedId, now = Date.now, home, folder, newAgent, openUrl, tickMs = 1000 }: AgentsScreenOptions): Promise<ScreenState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    let state = initialState({ agents: [], now: now(), home, folder });
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
    state = initialState({ agents, selectedId, now: now(), home, folder, freshStartAt });
    await Promise.all(agents.map((agent) => loadLog(agent.id)));

    return await new Promise<ScreenState>((resolve, reject) => {
      terminal.onKey((key) => {
        const update = onKey(state, key);
        state = update.state;
        if (update.commands.some((command) => command.type === "close")) resolve(state);
        else draw();
        // The host reports the effect of a command as events; a failing host ends the screen like any other host failure.
        for (const command of update.commands) {
          if (command.type === "open") openUrl(command.url);
          askNewAgent(command);
          execute(host, command).catch(reject);
        }
      });
      terminal.onResize(() => draw());
      timer = setInterval(() => {
        state = tick(state, now());
        draw(true);
      }, tickMs);
      draw();
    });
  } finally {
    clearInterval(timer);
    terminal.close();
  }
}
