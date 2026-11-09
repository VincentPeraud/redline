import { useEffect, useState, type ReactNode } from "react";
import { SetupScreen, SignInScreen } from "./AuthScreens.js";
import { useSession } from "./useMe.js";

const SETUP_HASH = /^#\/setup\/([^/?]+)/;

/** The setup link opens its own screen; people who are not signed in get the sign-in screen; the app shows only once we know who is there. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const setup = SETUP_HASH.exec(hash);
  if (setup && status !== "signedIn") return <SetupScreen token={decodeURIComponent(setup[1])} />;
  if (status === "loading") return null;
  if (status === "signedOut") return <SignInScreen />;
  return <>{children}</>;
}
