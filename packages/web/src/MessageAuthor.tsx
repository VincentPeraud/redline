import { UNKNOWN_PERSON_LABEL, type Person } from "@redline/shared";
import { cx } from "./ui/index.js";
import { usePersonLabel } from "./useMe.js";
import styles from "./MessageAuthor.module.css";

/**
 * The author of a message, on a line of its own above the text. `person` undefined with `claude` unset is a human
 * message from before the SSO ("Utilisateur inconnu") or without SSO ("Toi"). `bubble` is the smaller name above a conversation bubble.
 * `claude` is "Claude", or the longer name given: "Claude · App" for a project's session, "Claude · design system" in a request.
 */
export function MessageAuthor({ claude, person, bubble }: { claude?: true | string; person?: Person; bubble?: true }) {
  const label = usePersonLabel();
  const name = claude ? (claude === true ? "Claude" : claude) : label(person, "message");
  return (
    <span data-testid="message-author" className={cx(styles.author, bubble && styles.bubble, name === UNKNOWN_PERSON_LABEL && styles.unknown)}>
      {name}
    </span>
  );
}
