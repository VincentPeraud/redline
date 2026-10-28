import { applyEvent, initialState, logLoaded, onKey, render, tick, type ScreenState, type Size } from "./agents-view.js";
import type { HostClient } from "./host-client.js";

/** What the screen needs from the agent host: a `HostClient` provides it, tests give a fake. Later tickets add their commands here. */
export type ScreenHost = Pick<HostClient, "list" | "log" | "subscribe">;

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
  /** How often the clock of uptimes advances. Default 10 s. */
  tickMs?: number;
}

/** Runs the agents screen until the user closes it; resolves with the final state (for `closeSummary`). The terminal is restored on any outcome. */
export async function runAgentsScreen({ host, terminal, selectedId, now = Date.now, home, tickMs = 10_000 }: AgentsScreenOptions): Promise<ScreenState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    let state = initialState({ agents: [], now: now(), home });
    const draw = () => terminal.draw(render(state, terminal.size()));
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
    const agents = await host.list();
    state = initialState({ agents, selectedId, now: now(), home });
    await Promise.all(agents.map((agent) => loadLog(agent.id)));

    return await new Promise<ScreenState>((resolve) => {
      terminal.onKey((key) => {
        const update = onKey(state, key);
        state = update.state;
        if (update.commands.some((command) => command.type === "close")) resolve(state);
        else draw();
      });
      terminal.onResize(draw);
      timer = setInterval(() => {
        state = tick(state, now());
        draw();
      }, tickMs);
      draw();
    });
  } finally {
    clearInterval(timer);
    terminal.close();
  }
}
