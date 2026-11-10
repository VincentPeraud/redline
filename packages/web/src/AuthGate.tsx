import { useEffect, useState, type ReactNode } from "react";
import { AgentSignInScreen, InvitationScreen, PasswordLinkScreen, SetupScreen, SignInScreen, UnknownPersonScreen } from "./AuthScreens.js";
import { useMe, useSession } from "./useMe.js";

const SETUP_HASH = /^#\/setup\/([^/?]+)/;
const INVITATION_HASH = /^#\/invitation\/([^/?]+)/;
const AGENT_SIGN_IN_HASH = /^#\/connexion-agent\/([^/?]+)(?:\?(.*))?/;
const PASSWORD_LINK_HASH = /^#\/mot-de-passe\/([^/?]+)/;

/** The setup, invitation and password links open their own screen; people who are not signed in get the sign-in screen; the app shows only once we know who is there. */
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
  const passwordLink = PASSWORD_LINK_HASH.exec(hash);
  if (passwordLink && status !== "signedIn") return <PasswordLinkScreen token={decodeURIComponent(passwordLink[1])} />;
  const agentSignIn = AGENT_SIGN_IN_HASH.exec(hash);
  if (agentSignIn && status !== "signedIn") return <AgentSignInScreen token={decodeURIComponent(agentSignIn[1])} to={new URLSearchParams(agentSignIn[2]).get("to")} />;
  if (status === "loading") return null;
  if (status === "signedOut") return <SignInScreen />;
  if (status === "noAccess" && me?.noAccess) return <UnknownPersonScreen email={me.email} admins={me.noAccess.admins} logoutUrl={me.logoutUrl} />;
  return <>{children}</>;
}
