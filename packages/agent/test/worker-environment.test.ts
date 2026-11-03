import { describe, expect, it } from "vitest";
import { workerEnvironment } from "../src/worker-environment.js";

const host = { HOME: "/Users/me", PATH: "/usr/bin" };

describe("workerEnvironment", () => {
  it("leaves CLAUDE_CONFIG_DIR unset for the default directory, so the worker shares the terminal's keychain login", () => {
    const env = workerEnvironment({ host, client: {}, claudeConfigDir: "/Users/me/.claude" });
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("treats a trailing slash on the default directory as the default", () => {
    const env = workerEnvironment({ host, client: {}, claudeConfigDir: "/Users/me/.claude/" });
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("sets CLAUDE_CONFIG_DIR for any other directory", () => {
    const env = workerEnvironment({ host, client: {}, claudeConfigDir: "/Users/me/.claude-gp" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude-gp");
  });

  it("keeps CLAUDE_CONFIG_DIR when the launching terminal set it explicitly, as that terminal runs Claude", () => {
    const env = workerEnvironment({ host, client: { CLAUDE_CONFIG_DIR: "/Users/me/.claude" }, claudeConfigDir: "/Users/me/.claude" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude");
  });
});
