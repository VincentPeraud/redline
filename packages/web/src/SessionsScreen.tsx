import { useCallback, useEffect, useState } from "react";
import {
  CONTEXT_WARNING_PERCENT,
  SESSIONS_PATH,
  SESSION_FILTERS,
  sessionMatchesFilter,
  type SessionDetail,
  type SessionFilter,
  type SessionRow,
} from "@redline/shared";
import { routeHref } from "./router";
import { subscribeServerEvents } from "./serverEvents";
import { FILTER_LABEL, STATUS_LABEL, WAITING_NOTE, activityLabel, agentName, modelLine, shortSessionId } from "./sessionsView";

const cell = { padding: "8px 12px", textAlign: "left" as const, borderBottom: "1px solid #E4E2DC", font: "13px system-ui" };

export function SessionsScreen() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);

  const refresh = useCallback(async () => {
    setRows((await (await fetch(SESSIONS_PATH)).json()) as SessionRow[]);
    if (openId) {
      const res = await fetch(`${SESSIONS_PATH}/${openId}`);
      setDetail(res.ok ? ((await res.json()) as SessionDetail) : null);
    } else {
      setDetail(null);
    }
  }, [openId]);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeServerEvents(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 200);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const needle = search.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      sessionMatchesFilter(row.status, filter) &&
      (needle === "" || `${row.name} ${row.projectTitle} ${row.pageTitle}`.toLowerCase().includes(needle)),
  );

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, display: "flex", gap: 24 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1>Sessions</h1>
        <p>
          Chaque fil de commentaires et chaque conversation a sa propre session Claude, sur la machine de son agent. Clique sur
          une ligne pour l'ouvrir.
        </p>
        <div role="group" aria-label="Filtrer par statut" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {SESSION_FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} · {rows.filter((row) => sessionMatchesFilter(row.status, f)).length}
            </button>
          ))}
          <input
            aria-label="Rechercher une session"
            placeholder="Rechercher une session"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginLeft: "auto" }}
          />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Fil ou conversation", "Type", "Projet › page", "Statut", "Agent", "Session", "Modèle · effort · contexte", "Activité"].map((h) => (
                <th key={h} style={{ ...cell, color: "#5F5F68", fontWeight: 600 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const hot = (row.context?.percent ?? 0) >= CONTEXT_WARNING_PERCENT;
              return (
                <tr
                  key={row.id}
                  data-testid="session-row"
                  aria-selected={row.id === openId}
                  onClick={() => setOpenId(row.id)}
                  style={{ cursor: "pointer", background: row.id === openId ? "#F3F2EE" : undefined }}
                >
                  <td style={cell}>{row.name}</td>
                  <td style={cell}>{row.kind === "thread" ? "Fil" : "Conversation"}</td>
                  <td style={cell}>
                    {row.projectTitle} › {row.pageTitle}
                  </td>
                  <td style={cell} data-testid="session-status">
                    {STATUS_LABEL[row.status]}
                  </td>
                  <td style={cell}>{agentName(row)}</td>
                  <td style={{ ...cell, fontFamily: "monospace" }}>{shortSessionId(row.sessionId)}</td>
                  <td style={{ ...cell, color: hot ? "#C2410C" : undefined, fontWeight: hot ? 600 : undefined }}>{modelLine(row)}</td>
                  <td style={cell}>{activityLabel(row.activityAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && <p>Aucune session avec ce statut.</p>}
      </div>

      {detail && (
        <aside aria-label="Session ouverte" style={{ width: 380, flexShrink: 0 }}>
          <button type="button" aria-label="Fermer" onClick={() => setOpenId(null)} style={{ float: "right" }}>
            ×
          </button>
          <div style={{ font: "12px system-ui", color: "#5F5F68" }}>
            {detail.kind === "thread" ? "Fil" : "Conversation"} · {STATUS_LABEL[detail.status]}
          </div>
          <h2 style={{ margin: "4px 0" }}>{detail.name}</h2>
          <div>
            {detail.projectTitle} › {detail.pageTitle} <a href={`${routeHref({ name: "page", pageId: detail.pageId })}`}>Ouvrir sur la page</a>
          </div>
          <div style={{ font: "12px system-ui", margin: "4px 0 12px" }}>
            Agent {agentName(detail)} · {shortSessionId(detail.sessionId)}
          </div>
          {detail.messages.map((m, i) => (
            <p key={i} data-testid="session-message">
              <strong>{m.author === "user" ? "Toi" : "Claude"}</strong> — {m.body}
            </p>
          ))}
          {detail.status === "running" && <p>Claude travaille sur ce fil…</p>}
          {detail.waitingReason && <p>{WAITING_NOTE[detail.waitingReason]}</p>}
        </aside>
      )}
    </main>
  );
}
