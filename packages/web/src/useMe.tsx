import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ME_PATH, type MeResponse } from "@redline/shared";

const MeContext = createContext<MeResponse>(null);

/** Loads `GET /api/me` once: who is signed in, or null without SSO (and while loading). */
export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(ME_PATH)
      .then((res) => res.json() as Promise<MeResponse>)
      .then((loaded) => {
        if (!cancelled) setMe(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The person viewing, or null without SSO: the account block and pill show only when it is set. */
export function useMe(): MeResponse {
  return useContext(MeContext);
}
