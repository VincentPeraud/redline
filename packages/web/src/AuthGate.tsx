import { useEffect, useState, type ReactNode } from "react";
import { InvitationScreen, SetupScreen, SignInScreen, UnknownPersonScreen } from "./AuthScreens.js";
import { useMe, useSession } from "./useMe.js";

const SETUP_HASH = /^#\/setup\/([^/?]+)/;
const INVITATION_HASH = /^#\/invitation\/([^/?]+)/;

/** The setup and invitation links open their own screen; people who are not signed in get the sign-in screen; the app shows only once we know who is there. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const me = useMe();
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const setup = SETUP_HASH.exec(hash);
  if (setup && status !== "signedIn") return <SetupScreen token={decodeURIComponent(setup[1])} />;
  const invitation = INVITATION_HASH.exec(hash);
  if (invitation && status !== "signedIn") return <InvitationScreen token={decodeURIComponent(invitation[1])} />;
  if (status === "loading") return null;
  if (status === "signedOut") return <SignInScreen />;
  if (status === "noAccess" && me?.noAccess) return <UnknownPersonScreen email={me.email} admins={me.noAccess.admins} logoutUrl={me.logoutUrl} />;
  return <>{children}</>;
}
