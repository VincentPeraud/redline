import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { AgentsScreen } from "./AgentsScreen";
import { App } from "./App";
import { DesignSystemsScreen } from "./DesignSystemsScreen";
import { DesignMdScreen } from "./DesignMdScreen";
import { DiffusionProvider } from "./DiffusionDialog";
import { HomeScreen } from "./HomeScreen";
import { ProjectDesignSystemScreen } from "./ProjectDesignSystemScreen";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectsScreen } from "./ProjectsScreen";
import { Shell } from "./Sidebar";
import { useRoute } from "./router";
import { SessionsScreen } from "./SessionsScreen";

function Root() {
  const route = useRoute();
  switch (route.name) {
    case "page":
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
    case "projects":
      return <Shell><ProjectsScreen /></Shell>;
    case "sessions":
      return <Shell><SessionsScreen /></Shell>;
  }
}

createRoot(document.getElementById("root")!).render(
  <DiffusionProvider>
    <Root />
  </DiffusionProvider>,
);
