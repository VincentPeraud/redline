import { useCallback, useEffect, useState } from "react";
import type { AgentInfo, AgentTokenResponse } from "@redline/shared";

function maskToken(token: string): string {
  return token.length <= 8 ? "••••" : `${token.slice(0, 4)}••••••••••${token.slice(-4)}`;
}

export function AgentsScreen() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setAgents((await (await fetch("/api/agents")).json()) as AgentInfo[]);
  }, []);

  useEffect(() => {
    fetch("/api/agent-token")
      .then((res) => res.json() as Promise<AgentTokenResponse>)
      .then((body) => setToken(body.token));
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function copy() {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function regenerate() {
    if (!window.confirm("Regenerating the token disconnects every agent. Continue?")) return;
    const res = await fetch("/api/agent-token/regenerate", { method: "POST" });
    setToken(((await res.json()) as AgentTokenResponse).token);
    await refresh();
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 800 }}>
      <h1>Agents</h1>
      <p>
        An agent runs on your machine, in a folder, with the Claude account logged in in the terminal. Run{" "}
        <code>npm i -g redline-cli</code>, then <code>redline login {window.location.origin}</code> and{" "}
        <code>redline agent</code> in a project folder.
      </p>

      <section aria-label="Agents">
        {agents.length === 0 && <p>No agent has connected yet.</p>}
        {agents.map((agent) => (
          <div key={agent.id} style={{ display: "flex", gap: 16, padding: "12px 0", borderBottom: "1px solid #E4E2DC" }}>
            <span aria-label={agent.status} style={{ color: agent.status === "online" ? "#16A34A" : "#A1A1AA" }}>
              ●
            </span>
            <span style={{ flex: 1 }}>
              <strong>{agent.machine}</strong>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{agent.folder}</div>
            </span>
            <span>{agent.kind === "global" ? "Global agent" : "Project agent"}</span>
            <span>{agent.status === "online" ? "Online" : "Offline"}</span>
          </div>
        ))}
      </section>

      <section aria-label="Agents' token" style={{ marginTop: 32 }}>
        <h2>Agents' token</h2>
        <p>Asked by <code>redline login</code>. Regenerating it disconnects every agent.</p>
        <code data-testid="token">{token ? maskToken(token) : ""}</code>{" "}
        <button type="button" onClick={copy} disabled={!token}>
          {copied ? "Copied" : "Copy"}
        </button>{" "}
        <button type="button" onClick={regenerate}>
          Regenerate
        </button>
      </section>
    </main>
  );
}
