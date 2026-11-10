import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ME_PATH, SESSION_PATH, personLabel, type MeResponse, type Person, type PersonPlace } from "@redline/shared";
import type { Who } from "./historyLabels.js";
import { UNAUTHORIZED_EVENT } from "./apiCalls.js";

const MeContext = createContext<MeResponse>(null);

/** Whether the built-in accounts need a sign-in (the API answered 401), or the SSO let in someone Redline has no account for (`noAccess`). */
export interface SessionState {
  /** `loading` until `GET /api/me` has answered. */
  status: "loading" | "signedIn" | "signedOut" | "noAccess";
  /** The sign-in screen says "Tu es déconnecté." after a sign-out of the person's own. */
  justSignedOut: boolean;
  /** Reads `GET /api/me` again, after a sign-in or the creation of the first admin. */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({ status: "signedIn", justSignedOut: false, reload: async () => {}, signOut: async () => {} });

/** Loads `GET /api/me` once: who is signed in, or null without SSO (and while loading); a 401 means the sign-in screen. */
export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse>(null);
  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [justSignedOut, setJustSignedOut] = useState(false);

  const reload = useCallback(async () => {
    const res = await fetch(ME_PATH);
    if (res.status === 401) {
      setMe(null);
      setStatus("signedOut");
      return;
    }
    const body = (await res.json()) as MeResponse;
    setMe(body);
    setStatus(body?.noAccess ? "noAccess" : "signedIn");
  }, []);

  useEffect(() => {
    void reload();
    // A session that ended (expired, signed out elsewhere) shows on the next call of the app.
    const onUnauthorized = () => setStatus("signedOut");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [reload]);

  const signOut = useCallback(async () => {
    await fetch(SESSION_PATH, { method: "DELETE" });
    setMe(null);
    setJustSignedOut(true);
    setStatus("signedOut");
  }, []);

  const session = useMemo<SessionState>(() => ({ status, justSignedOut, reload, signOut }), [status, justSignedOut, reload, signOut]);
  return (
    <SessionContext.Provider value={session}>
      <MeContext.Provider value={me}>{children}</MeContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}

/** The person viewing, or null without SSO: the account block and pill show only when it is set. */
export function useMe(): MeResponse {
  return useContext(MeContext);
}

/**
 * The one way to name who did something (messages here, histories and lists in the following tickets): "Toi", the
 * person's name, "Utilisateur inconnu" / nothing / "—" when nobody is known, today's labels without SSO. See `personLabel`.
 */
export function usePersonLabel(): (person: Person | undefined, place: PersonPlace) => string | undefined {
  const me = useMe();
  return (person, place) => personLabel(person, me, place);
}

/** Names the person behind an action in a history, a list or DESIGN.md (see `historyLabels`). */
export function useWho(): (person: Person | undefined) => Who {
  const me = useMe();
  return (person) => {
    const name = personLabel(person, me, "history");
    return name === undefined ? { sso: me !== null } : { sso: me !== null, name };
  };
}
