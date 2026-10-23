import type { ReactNode } from "react";
import { routeHref, useRoute, type Route } from "./router.js";
import { HomeProvider, useHome } from "./useHome.js";
import { cx, Logo } from "./ui/index.js";
import styles from "./Sidebar.module.css";

const NAV: { label: string; route: Route; active: Route["name"][] }[] = [
  { label: "Accueil", route: { name: "home" }, active: ["home"] },
  { label: "Projets", route: { name: "projects" }, active: ["projects", "project", "designMd"] },
  { label: "Design systems", route: { name: "designSystems" }, active: ["designSystems"] },
  { label: "Sessions", route: { name: "sessions" }, active: ["sessions"] },
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
    <div data-testid="sidebar-agents" className={styles.agents}>
      <div className={styles.agentsLine}>
        <span aria-hidden="true" className={cx(styles.dot, online === 0 && styles.dotOffline)} />
        <span data-testid="sidebar-online">{online === 0 ? "Aucun agent connecté" : plural(online, "agent connecté", "agents connectés")}</span>
      </div>
      <div data-testid="sidebar-details" className={styles.agentsDetails}>
        {offline} hors ligne · {plural(home.waitingThreads, "fil en attente", "fils en attente")}
      </div>
    </div>
  );
}

function Nav() {
  const route = useRoute();
  return (
    <nav aria-label="Navigation principale" className={styles.nav}>
      <div className={styles.navInner}>
        <div className={styles.logo}>
          <Logo />
        </div>
        {NAV.map((item) => {
          const current = item.active.includes(route.name);
          return (
            <a key={item.label} href={routeHref(item.route)} aria-current={current ? "page" : undefined} className={cx(styles.link, current && styles.current)}>
              {item.label}
            </a>
          );
        })}
        <div className={styles.spacer} />
        <AgentStatusBox />
      </div>
    </nav>
  );
}

/**
 * Sidebar with the live agent counts around a screen; the page canvas has its own layout and skips it.
 * The screen is a flex child: render a `PageContent` (and optionally a `SidePanel` next to it).
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <HomeProvider>
      <div className={styles.shell}>
        <Nav />
        <div className={styles.content}>{children}</div>
      </div>
    </HomeProvider>
  );
}
