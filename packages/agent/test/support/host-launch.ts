import { fileURLToPath } from "node:url";

/** Runs a TypeScript file of the test support with the repository's path mappings. */
const tsxEnv = { TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../../scripts/tsconfig.json", import.meta.url)) };

export function tsxCommand(file: string, env: NodeJS.ProcessEnv = {}) {
  return { command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL(file, import.meta.url))], env: { ...tsxEnv, ...env } };
}

export const hostWorkerCommand = (env: NodeJS.ProcessEnv = {}) => tsxCommand("./host-worker.ts", env);
