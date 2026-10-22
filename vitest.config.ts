import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@redline/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@redline/server/test-harness": fileURLToPath(new URL("./packages/server/src/test-harness.ts", import.meta.url)),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
