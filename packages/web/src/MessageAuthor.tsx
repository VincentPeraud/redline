import { UNKNOWN_PERSON_LABEL, type LinkAuthor, type Person, type ThreadReply } from "@redline/shared";
import { cx } from "./ui/index.js";
import { usePersonLabel } from "./useMe.js";
import styles from "./MessageAuthor.module.css";

/**
 * The author of a message, on a line of its own above the text. `person` undefined with `claude` unset is a human
 * message from before the SSO ("Utilisateur inconnu") or without SSO ("Toi"). `bubble` is the smaller name above a conversation bubble.
 * `linkAuthor`: written through a share link, shown "Marc (lien)". `claude` is "Claude", or the longer name given: "Claude · App" for a project's session, "Claude · design system" in a request.
 */
export function MessageAuthor({ claude, person, linkAuthor, bubble, redline, conversation, aside }: { claude?: true | string; person?: Person; linkAuthor?: LinkAuthor; bubble?: true; redline?: true; conversation?: ThreadReply["conversation"]; aside?: string }) {
  const label = usePersonLabel();
  const name = redline ? "Redline" : claude ? (claude === true ? "Claude" : claude) : linkAuthor ? (aside ? linkAuthor.name : `${linkAuthor.name} (lien)`) : label(person, "message");
  return (
    <span data-testid="message-author" className={cx(styles.author, bubble && styles.bubble, name === UNKNOWN_PERSON_LABEL && styles.unknown)}>
      {name}
      {aside && (
        <>
          {" "}
          <small className={styles.signature}>· {aside}</small>
        </>
      )}
      {conversation && (
        <>
          {" "}
          <small className={styles.signature}>
            · {conversation.person ? `conversation de ${conversation.person.name || conversation.person.email}` : "conversation"} · {conversation.folder}
          </small>
        </>
      )}
    </span>
  );
}
