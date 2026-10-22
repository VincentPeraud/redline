import { createRoot } from "react-dom/client";
import { AgentsScreen } from "./AgentsScreen";
import { App } from "./App";

window.addEventListener("hashchange", () => window.location.reload());

createRoot(document.getElementById("root")!).render(window.location.hash === "#/agents" ? <AgentsScreen /> : <App />);
