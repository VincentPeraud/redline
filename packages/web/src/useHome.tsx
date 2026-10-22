import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { HOME_PATH, type HomeOverview } from "@redline/shared";
import { subscribeServerEvents } from "./serverEvents.js";

const REFRESH_DELAY_MS = 150;

const HomeContext = createContext<{ home: HomeOverview | null; refresh: () => void }>({ home: null, refresh: () => {} });

/** Loads `GET /api/home` and reloads it (debounced) on every server event, so counts and statuses stay live. */
export function HomeProvider({ children }: { children: ReactNode }) {
  const [home, setHome] = useState<HomeOverview | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(HOME_PATH)
      .then((res) => res.json() as Promise<HomeOverview>)
      .then((loaded) => {
        if (!cancelled) setHome(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeServerEvents(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), REFRESH_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return <HomeContext.Provider value={{ home, refresh: () => setVersion((v) => v + 1) }}>{children}</HomeContext.Provider>;
}

export function useHome() {
  return useContext(HomeContext);
}
