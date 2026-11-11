import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@redline/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@redline/agent/seam2": fileURLToPath(new URL("./packages/agent/test/support/seam2.ts", import.meta.url)),
      "@redline/server/test-harness": fileURLToPath(new URL("./packages/server/src/test-harness.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    hookTimeout: 30000,
    // The web app the journeys serve, built once for the whole run
    globalSetup: ["packages/web/test/support/build-web-once.ts"],
    // Journeys each run a Chromium and a server: one file per core saturates the machine and tests time out at random,
    // while half the cores finishes in the same time.
    maxWorkers: "50%",
    minWorkers: 1,
    testTimeout: 15000,
    // expect.poll waits 1 s by default: too short for a run, a publish and a reload on a busy machine
    expect: { poll: { timeout: 5000 } },
  },
});
