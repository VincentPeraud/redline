import { createRoot } from "react-dom/client";
import { AgentsScreen } from "./AgentsScreen";
import { App } from "./App";
import { DesignMdScreen } from "./DesignMdScreen";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectsScreen } from "./ProjectsScreen";
import { useRoute } from "./router";
import { SessionsScreen } from "./SessionsScreen";

function Root() {
  const route = useRoute();
  switch (route.name) {
    case "agents":
      return <AgentsScreen />;
    case "sessions":
      return <SessionsScreen />;
    case "project":
      return <ProjectOverview key={route.projectId} projectId={route.projectId} />;
    case "designMd":
      return <DesignMdScreen key={route.projectId} projectId={route.projectId} />;
    case "page":
      return <App key={route.pageId} pageId={route.pageId} />;
    case "projects":
      return <ProjectsScreen />;
  }
}

createRoot(document.getElementById("root")!).render(<Root />);
