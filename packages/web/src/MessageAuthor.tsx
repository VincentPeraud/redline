import { UNKNOWN_PERSON_LABEL, type LinkAuthor, type Person } from "@redline/shared";
import { cx } from "./ui/index.js";
import { usePersonLabel } from "./useMe.js";
import styles from "./MessageAuthor.module.css";

/**
 * The author of a message, on a line of its own above the text. `person` undefined with `claude` unset is a human
 * message from before the SSO ("Utilisateur inconnu") or without SSO ("Toi"). `bubble` is the smaller name above a conversation bubble.
 * `linkAuthor`: written through a share link, shown "Marc (lien)". `claude` is "Claude", or the longer name given: "Claude · App" for a project's session, "Claude · design system" in a request.
 */
export function MessageAuthor({ claude, person, linkAuthor, bubble, redline }: { claude?: true | string; person?: Person; linkAuthor?: LinkAuthor; bubble?: true; redline?: true }) {
  const label = usePersonLabel();
  const name = redline ? "Redline" : claude ? (claude === true ? "Claude" : claude) : linkAuthor ? `${linkAuthor.name} (lien)` : label(person, "message");
  return (
    <span data-testid="message-author" className={cx(styles.author, bubble && styles.bubble, name === UNKNOWN_PERSON_LABEL && styles.unknown)}>
      {name}
    </span>
  );
}
