import type { CSSProperties, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { AccountsScreen } from "./AccountsScreen.js";
import { AgentsScreen } from "./AgentsScreen";
import { AgentUpdateBanner, useOutdatedAgentNames } from "./AgentUpdateBanner.js";
import { App } from "./App";
import { BeforeAfterScreen } from "./BeforeAfterScreen";
import { DesignSystemOverview } from "./DesignSystemOverview";
import { ArchivedDesignSystemsScreen, DesignSystemsScreen } from "./DesignSystemsScreen";
import { DesignMdScreen } from "./DesignMdScreen";
import { DiffusionProvider } from "./DiffusionDialog";
import { HomeScreen } from "./HomeScreen";
import { ProjectDesignSystemScreen } from "./ProjectDesignSystemScreen";
import { ProjectOverview } from "./ProjectOverview";
import { ArchivedProjectsScreen, ProjectsScreen } from "./ProjectsScreen";
import { Shell } from "./Sidebar";
import { AuthGate } from "./AuthGate.js";
import { installApiCalls } from "./apiCalls.js";
import { MeProvider, useMe } from "./useMe.js";
import { NoAccessScreen } from "./AuthScreens.js";
import { useRoute } from "./router";
import { SessionsScreen } from "./SessionsScreen";
import { HomeProvider } from "./useHome.js";
import { notePageRoute } from "./viaProject.js";
import { useDocumentTitle } from "./documentTitle.js";
import type { Route } from "./router";

/** Tab titles of the screens that have no name of their own; the others (a page, a project, a design system) set theirs. */
const SECTION_TITLES: Partial<Record<Route["name"], string>> = {
  home: "Accueil",
  agents: "Agents",
  sessions: "Sessions",
  accounts: "Comptes",
  projects: "Projets",
  archivedProjects: "Projets archivés",
  designSystems: "Design systems",
  archivedDesignSystems: "Design systems archivés",
};

function SectionTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

/** The banner on top of every screen; the screens below shrink by its height (`--banner-height`). */
function WithBanner({ children }: { children: ReactNode }) {
  const bannerShown = useOutdatedAgentNames().length > 0;
  return (
    <div style={{ "--banner-height": bannerShown ? "var(--banner-size)" : "0px" } as CSSProperties}>
      <AgentUpdateBanner />
      {children}
    </div>
  );
}

function Screen() {
  const route = useRoute();
  const section = SECTION_TITLES[route.name];
  return (
    <>
      {section && <SectionTitle key={section} title={section} />}
      <RouteScreen route={route} />
    </>
  );
}

function RouteScreen({ route }: { route: Route }) {
  notePageRoute(route.name === "page" ? route.pageId : undefined, route.name === "page" ? route.viaProjectId : undefined);
  switch (route.name) {
    case "page":
      return <App key={route.pageId} route={route} />;
    case "home":
      return <Shell><HomeScreen /></Shell>;
    case "agents":
      return <Shell><AgentsScreen /></Shell>;
    case "accounts":
      return <AccountsRoute />;
    case "project":
      return <ProjectOverview key={route.projectId} projectId={route.projectId} />;
    case "designMd":
      return <DesignMdScreen key={route.projectId} projectId={route.projectId} />;
    case "projectDesignSystem":
      return <ProjectDesignSystemScreen key={route.projectId} projectId={route.projectId} />;
    case "designSystems":
      return <Shell><DesignSystemsScreen /></Shell>;
    case "designSystem":
      return <DesignSystemOverview key={route.designSystemId} designSystemId={route.designSystemId} viaProjectId={route.viaProjectId} review={route.review} />;
    case "beforeAfter":
      return <BeforeAfterScreen key={`${route.designSystemId}/${route.component}`} designSystemId={route.designSystemId} component={route.component} />;
    case "projects":
      return <Shell><ProjectsScreen /></Shell>;
    case "archivedProjects":
      return <Shell><ArchivedProjectsScreen /></Shell>;
    case "archivedDesignSystems":
      return <Shell><ArchivedDesignSystemsScreen /></Shell>;
    case "sessions":
      return <Shell><SessionsScreen /></Shell>;
  }
}

/** Comptes is for admins: a member who opens its address gets the no-access screen. */
function AccountsRoute() {
  const me = useMe();
  return me?.account?.role === "admin" ? <Shell><AccountsScreen /></Shell> : <NoAccessScreen />;
}

function Root() {
  return (
    <HomeProvider>
      <WithBanner>
        <Screen />
      </WithBanner>
    </HomeProvider>
  );
}

installApiCalls();

createRoot(document.getElementById("root")!).render(
  <MeProvider>
    <AuthGate>
      <DiffusionProvider>
        <Root />
      </DiffusionProvider>
    </AuthGate>
  </MeProvider>,
);
