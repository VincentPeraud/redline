import { createContext, useContext, useEffect, useState } from "react";
import { LINK_DEAD_CODE, type LinkDeadResponse, type ShareLinkView } from "@redline/shared";
import { App } from "./App.js";
import { DiffusionProvider } from "./DiffusionDialog.js";
import { DeadLinkScreen } from "./AuthScreens.js";
import { LINK_TOKEN } from "./linkAddress.js";
import { type PageRoute, useRoute } from "./router.js";

/** Window width up to which a link visitor is on a phone: the link opens the presentation. */
export const PHONE_VISITOR_MAX_WIDTH = 700;

/** What a share link opens for the person holding it. */
export interface VisitorState {
  token: string;
  view: ShareLinkView;
}

const VisitorContext = createContext<VisitorState | null>(null);

/** The visitor's link, or null in the normal app: components hide what the link's level does not allow. */
export function useVisitor(): VisitorState | null {
  return useContext(VisitorContext);
}

type Loaded = { state: "loading" } | { state: "dead" } | { state: "open"; view: ShareLinkView };

function isDead(body: unknown): boolean {
  return (body as Partial<LinkDeadResponse> | null)?.code === LINK_DEAD_CODE;
}

/** The page of the link only: the canvas and the presentation of the app, with what the level forbids hidden. */
function VisitorPage({ view, token }: { view: ShareLinkView; token: string }) {
  const route = useRoute();
  const own: PageRoute = route.name === "page" && route.pageId === view.page.id ? route : { name: "page", pageId: view.page.id };
  return (
    <VisitorContext.Provider value={{ token, view }}>
      <DiffusionProvider>
        <App key={own.pageId} route={own} />
      </DiffusionProvider>
    </VisitorContext.Provider>
  );
}

/** Root of `/s/<token>`: asks what the link opens, then shows its page, the normal page for a member who may already do as much, or the dead-link screen. */
export function VisitorApp() {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/link");
      const body: unknown = await response.json().catch(() => null);
      if (cancelled) return;
      if (!response.ok || isDead(body)) return setLoaded({ state: "dead" });
      const view = body as ShareLinkView;
      if (view.memberRedirect) {
        window.location.replace(`/${window.location.hash === "" ? `#/pages/${view.page.id}` : window.location.hash}`);
        return;
      }
      setLoaded({ state: "open", view });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (loaded.state === "loading") return null;
  if (loaded.state === "dead" || LINK_TOKEN === undefined) return <DeadLinkScreen />;
  return <VisitorPage view={loaded.view} token={LINK_TOKEN} />;
}
