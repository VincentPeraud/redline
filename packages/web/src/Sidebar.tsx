import type { ReactNode } from "react";
import { routeHref, useRoute, type Route } from "./router.js";
import { HomeProvider, useHome } from "./useHome.js";

const NAV: { label: string; route: Route; active: Route["name"][] }[] = [
  { label: "Accueil", route: { name: "home" }, active: ["home"] },
  { label: "Projets", route: { name: "projects" }, active: ["projects", "project", "designMd"] },
  { label: "Design systems", route: { name: "designSystems" }, active: ["designSystems"] },
  { label: "Agents", route: { name: "agents" }, active: ["agents"] },
];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count <= 1 ? one : many}`;
}

function AgentStatusBox() {
  const { home } = useHome();
  if (!home) return null;
  const online = home.agents.filter((a) => a.status === "online").length;
  const offline = home.agents.length - online;
  return (
    <div data-testid="sidebar-agents" style={{ border: "1px solid #E4E2DC", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: online > 0 ? "#16A34A" : "#A1A1AA" }} />
        <span data-testid="sidebar-online">{online === 0 ? "Aucun agent connecté" : plural(online, "agent connecté", "agents connectés")}</span>
      </div>
      <div data-testid="sidebar-details" style={{ fontSize: 12, lineHeight: 1.5, color: "#5F5F68" }}>
        {offline} hors ligne · {plural(home.waitingThreads, "fil en attente", "fils en attente")}
      </div>
    </div>
  );
}

function Nav() {
  const route = useRoute();
  return (
    <nav
      aria-label="Navigation principale"
      style={{ width: 240, flexShrink: 0, boxSizing: "border-box", padding: "20px 16px", borderRight: "1px solid #E4E2DC", background: "#FFFFFF", display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div style={{ padding: "4px 10px 20px", fontWeight: 700 }}>redline</div>
      {NAV.map((item) => {
        const current = item.active.includes(route.name);
        return (
          <a
            key={item.label}
            href={routeHref(item.route)}
            aria-current={current ? "page" : undefined}
            style={{ textDecoration: "none", color: current ? "#18181B" : "#3F3F46", background: current ? "#F3F2EE" : undefined, borderRadius: 8, padding: "10px 12px", fontSize: 14, fontWeight: current ? 500 : 400 }}
          >
            {item.label}
          </a>
        );
      })}
      <div style={{ flexGrow: 1 }} />
      <AgentStatusBox />
    </nav>
  );
}

/** Sidebar with the live agent counts around a screen; the page canvas has its own layout and skips it. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <HomeProvider>
      <div style={{ display: "flex", minHeight: "100vh", background: "#F6F5F2", color: "#18181B", fontFamily: "system-ui, sans-serif" }}>
        <Nav />
        <div style={{ flexGrow: 1, minWidth: 0 }}>{children}</div>
      </div>
    </HomeProvider>
  );
}
