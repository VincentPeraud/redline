import { hostname } from "node:os";
import type { Engine } from "./engine.js";
import type { HostToWorker, WorkerToHost } from "./host-protocol.js";
import { serveAgent } from "./serve-agent.js";
import { UPDATE_EXIT_CODE } from "./supervisor.js";

/**
 * Entry of a worker process of the agent host: waits for its configuration on the parent channel, then runs
 * today's agent loop until told to stop, refused by the server, or updated (exit `UPDATE_EXIT_CODE`).
 */
export function runAgentWorker({ engine }: { engine: Engine }): void {
  if (!process.send) throw new Error("An agent worker is started by the agent host.");
  const send = (message: WorkerToHost, then: () => void) => process.send!(message, then);
  let service: ReturnType<typeof serveAgent> | undefined;

  process.on("message", (message: HostToWorker) => {
    if (message.type === "start" && !service) {
      const { machine = hostname(), ...config } = message.config;
      service = serveAgent({ ...config, machine, engine });
      service.done.then(
        ({ updated }) => process.exit(updated ? UPDATE_EXIT_CODE : 0),
        (error: Error) => send({ type: "failed", reason: error.message }, () => process.exit(1)),
      );
    } else if (message.type === "stop") {
      if (service) service.stop();
      else process.exit(0);
    }
  });
  // The host is gone: nobody can stop this worker any more.
  process.on("disconnect", () => {
    if (service) service.stop();
    else process.exit(0);
  });
}
