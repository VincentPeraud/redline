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
import { Avatar } from "./Avatar.js";
import { MessageAuthor } from "./MessageAuthor.js";
import { routeHref } from "./router";
import { subscribeServerEvents } from "./serverEvents";
import { useMe, usePersonLabel } from "./useMe.js";
import { FILTER_LABEL, WAITING_NOTE, activityLabel, agentName, modelLine, shortSessionId } from "./sessionsView";
import {
  FilterPill,
  PageContent,
  PageHeader,
  SessionStatusBadge,
  SidePanel,
  SidePanelBody,
  SidePanelFooter,
  SidePanelHeader,
  StatusBadge,
  Table,
  TextInput,
  Tooltip,
  Textarea,
  cx,
  type TableColumn,
} from "./ui/index.js";
import styles from "./SessionsScreen.module.css";

const kindLabel = (row: SessionRow) => (row.kind === "thread" ? "Fil" : "Conversation");
const isHot = (row: SessionRow) => (row.context?.percent ?? 0) >= CONTEXT_WARNING_PERCENT;

function Launcher({ row }: { row: SessionRow }) {
  const me = useMe();
  const label = usePersonLabel();
  const { startedBy } = row;
  const name = label(startedBy, "launcher");
  if (!startedBy || !me) return <span className={styles.unknown}>{name}</span>;
  return (
    <span className={styles.launcher}>
      <Avatar small muted={startedBy.id !== me.id} initials={startedBy.initials} />
      {name}
    </span>
  );
}

const COLUMNS: Record<string, Omit<TableColumn<SessionRow>, "width">> = {
  name: { key: "name", header: "Fil ou conversation", render: (row) => <span className={styles.name}>{row.name}</span> },
  launcher: { key: "launcher", header: "Lancé par", render: (row) => <Launcher row={row} /> },
  type: { key: "type", header: "Type", render: (row) => <span className={styles.secondary}>{kindLabel(row)}</span> },
  where: {
    key: "where",
    header: "Projet › page",
    render: (row) => (
      <span className={styles.secondary}>
        {row.projectTitle} › {row.pageTitle}
      </span>
    ),
  },
  status: {
    key: "status",
    header: "Statut",
    render: (row) => (
      <span data-testid="session-status">
        <SessionStatusBadge status={row.status} inline />
      </span>
    ),
  },
  agent: { key: "agent", header: "Agent", render: (row) => <span className={styles.secondary}>{agentName(row)}</span> },
  session: { key: "session", header: "Session", render: (row) => <span className={styles.mono}>{shortSessionId(row.sessionId)}</span> },
  model: {
    key: "model",
    header: "Modèle · effort · contexte",
    render: (row) => <span className={cx(styles.model, isHot(row) && styles.hot)}>{modelLine(row)}</span>,
  },
  when: { key: "when", header: "Activité", render: (row) => <span className={styles.when}>{activityLabel(row.activityAt)}</span> },
};

/** The board shows every column when no session is open, and only four next to the side panel. */
const WIDE: [string, string][] = [["name", "1.9fr"], ["launcher", "1.5fr"], ["type", "0.7fr"], ["where", "1.4fr"], ["status", "1.5fr"], ["agent", "0.8fr"], ["session", "0.8fr"], ["model", "1.4fr"], ["when", "0.9fr"]];
const NARROW: [string, string][] = [["name", "1.8fr"], ["launcher", "1.4fr"], ["where", "1.4fr"], ["status", "1.3fr"], ["when", "0.8fr"]];

function columnsFor(layout: [string, string][], showLauncher: boolean): TableColumn<SessionRow>[] {
  return layout.filter(([key]) => showLauncher || key !== "launcher").map(([key, width]) => ({ ...COLUMNS[key]!, width }));
}

const MESSAGES_PATH = { thread: "/api/threads", conversation: "/api/conversations" } as const;

/** Reply composer of the side panel: Enter sends, Shift+Enter adds a line. Sending resumes the session. */
function Composer({ session, onSent }: { session: SessionDetail; onSent: () => void }) {
  const [text, setText] = useState("");

  async function send() {
    if (text.trim() === "") return;
    await fetch(`${MESSAGES_PATH[session.kind]}/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    setText("");
    onSent();
  }

  return (
    <>
      <label htmlFor="reponse-session" className={styles.composerLabel}>
        Répondre
      </label>
      <Textarea
        id="reponse-session"
        className={styles.composerInput}
        rows={3}
        placeholder="Ta réponse reprend la même session…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
    </>
  );
}

export function SessionsScreen() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const me = useMe();
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
      (!mineOnly || row.startedBy?.id === me?.id) &&
      (needle === "" || `${row.name} ${row.projectTitle} ${row.pageTitle}`.toLowerCase().includes(needle)),
  );

  return (
    <>
      <PageContent>
        <PageHeader
          title="Sessions"
          subtitle="Chaque fil de commentaires et chaque conversation a sa propre session Claude, sur la machine de son agent. Clique sur une ligne pour l'ouvrir."
        />
        <div className={styles.toolbar}>
          <div role="group" aria-label="Filtrer par statut" className={styles.filters}>
            {SESSION_FILTERS.map((f) => (
              <FilterPill key={f} active={filter === f} count={rows.filter((row) => sessionMatchesFilter(row.status, f)).length} onClick={() => setFilter(f)}>
                {FILTER_LABEL[f]}
              </FilterPill>
            ))}
            {me && (
              <FilterPill active={mineOnly} count={rows.filter((row) => row.startedBy?.id === me.id).length} onClick={() => setMineOnly(!mineOnly)}>
                Mes sessions
              </FilterPill>
            )}
          </div>
          <div className={styles.spacer} />
          <TextInput
            type="search"
            size="md"
            className={styles.search}
            aria-label="Rechercher une session"
            placeholder="Rechercher un fil, une page…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Table
          columns={columnsFor(detail ? NARROW : WIDE, me !== null)}
          rows={visible}
          rowKey={(row) => row.id}
          rowTestId="session-row"
          selectedKey={openId}
          onRowClick={(row) => setOpenId(row.id)}
          empty="Aucune session avec ce statut."
        />
      </PageContent>

      {detail && (
        <SidePanel label="Session sélectionnée">
          <SidePanelHeader>
            <div className={styles.badges}>
              <StatusBadge tone="neutral" size="sm">
                {kindLabel(detail)}
              </StatusBadge>
              <SessionStatusBadge status={detail.status} size="sm" />
              <span className={styles.spacer} />
              <Tooltip label="Fermer le panneau">
                <button type="button" className={styles.close} aria-label="Fermer le panneau" onClick={() => setOpenId(null)}>
                  ×
                </button>
              </Tooltip>
            </div>
            <h2 className={styles.title}>{detail.name}</h2>
            <div className={styles.where}>
              <span>
                {detail.projectTitle} › {detail.pageTitle}
              </span>
              <span className={styles.spacer} />
              <a href={routeHref({ name: "page", pageId: detail.pageId })}>Ouvrir sur la page</a>
            </div>
            <div className={styles.meta}>
              Agent {agentName(detail)} · <span className={styles.metaMono}>{shortSessionId(detail.sessionId)}</span>
              {modelLine(detail) !== "—" && (
                <>
                  {" · "}
                  <span className={cx(styles.metaMono, isHot(detail) && styles.hot)}>{modelLine(detail)}</span>
                </>
              )}
            </div>
          </SidePanelHeader>
          <SidePanelBody>
            {detail.messages.map((m, i) => (
              <div key={i} data-testid="session-message" className={cx(styles.message, m.author === "user" ? styles.fromUser : styles.fromClaude)}>
                {m.author === "user" ? <MessageAuthor person={m.person} /> : <MessageAuthor claude />}
                {m.body}
              </div>
            ))}
            {detail.status === "running" && (
              <div className={styles.working}>
                <span aria-hidden="true" className={styles.dots}>
                  <span />
                  <span />
                  <span />
                </span>
                Claude travaille sur ce fil…
              </div>
            )}
            {detail.waitingReason && <div className={styles.note}>{WAITING_NOTE[detail.waitingReason]}</div>}
          </SidePanelBody>
          <SidePanelFooter>
            <Composer key={detail.id} session={detail} onSent={() => void refresh()} />
          </SidePanelFooter>
        </SidePanel>
      )}
    </>
  );
}
