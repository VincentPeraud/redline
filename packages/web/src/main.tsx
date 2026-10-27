import type { CSSProperties, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { AgentsScreen } from "./AgentsScreen";
import { AgentUpdateBanner, useOutdatedAgentNames } from "./AgentUpdateBanner.js";
import { App } from "./App";
import { DesignSystemOverview } from "./DesignSystemOverview";
import { DesignSystemsScreen } from "./DesignSystemsScreen";
import { DesignMdScreen } from "./DesignMdScreen";
import { DiffusionProvider } from "./DiffusionDialog";
import { HomeScreen } from "./HomeScreen";
import { ProjectDesignSystemScreen } from "./ProjectDesignSystemScreen";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectsScreen } from "./ProjectsScreen";
import { Shell } from "./Sidebar";
import { MeProvider } from "./useMe.js";
import { useRoute } from "./router";
import { SessionsScreen } from "./SessionsScreen";
import { HomeProvider } from "./useHome.js";
import { rememberViaProject } from "./viaProject.js";

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
  switch (route.name) {
    case "page":
      rememberViaProject(route.pageId, route.viaProjectId);
      return <App key={route.pageId} route={route} />;
    case "home":
      return <Shell><HomeScreen /></Shell>;
    case "agents":
      return <Shell><AgentsScreen /></Shell>;
    case "project":
      return <ProjectOverview key={route.projectId} projectId={route.projectId} />;
    case "designMd":
      return <DesignMdScreen key={route.projectId} projectId={route.projectId} />;
    case "projectDesignSystem":
      return <ProjectDesignSystemScreen key={route.projectId} projectId={route.projectId} />;
    case "designSystems":
      return <Shell><DesignSystemsScreen /></Shell>;
    case "designSystem":
      return <DesignSystemOverview key={route.designSystemId} designSystemId={route.designSystemId} viaProjectId={route.viaProjectId} />;
    case "projects":
      return <Shell><ProjectsScreen /></Shell>;
    case "sessions":
      return <Shell><SessionsScreen /></Shell>;
  }
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

createRoot(document.getElementById("root")!).render(
  <MeProvider>
    <DiffusionProvider>
      <Root />
    </DiffusionProvider>
  </MeProvider>,
);
