import { connectToServer, type AgentConnection, type ConnectOptions } from "./connection.js";
import type { Engine } from "./engine.js";
import { ServerApi } from "./server-api.js";
import { runWorkItem } from "./work-runner.js";

export interface AgentOptions extends Omit<ConnectOptions, "onMessage"> {
  engine: Engine;
}

/** Connects to the server and runs the work items it pushes, with the given engine. */
export async function startAgent({ engine, ...connect }: AgentOptions): Promise<AgentConnection> {
  const api = new ServerApi(connect.serverUrl, connect.token, connect.buildHash);
  const connection = await connectToServer({
    ...connect,
    onMessage(message) {
      if (message.type === "work") {
        const item = { ...message.item, model: message.item.model ?? connect.model, effort: message.item.effort ?? connect.effort };
        void runWorkItem(item, { folder: connect.folder, api, engine, send: (m) => connection.send(m) });
      }
    },
  });
  return connection;
}
