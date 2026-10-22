import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Resolve the shared package to source so the web app builds and tests run without building it first.
  resolve: { alias: { "@redline/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) } },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
