import { createRoot } from "react-dom/client";
import { AgentsScreen } from "./AgentsScreen";
import { App } from "./App";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectsScreen } from "./ProjectsScreen";
import { useRoute } from "./router";

function Root() {
  const route = useRoute();
  switch (route.name) {
    case "agents":
      return <AgentsScreen />;
    case "project":
      return <ProjectOverview key={route.projectId} projectId={route.projectId} />;
    case "page":
      return <App key={route.pageId} pageId={route.pageId} />;
    case "projects":
      return <ProjectsScreen />;
  }
}

createRoot(document.getElementById("root")!).render(<Root />);
