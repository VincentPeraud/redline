import type { AccessLevel } from "@redline/shared";
import { nameOf } from "./person-name.js";
import type { Store } from "./store.js";

/** The account's display name; its e-mail follows when another active account has the same name. */
export const accountName = (store: Store, accountId: string): string => {
  const person = store.getPerson(accountId || null);
  if (!person) return "the shared account";
  const name = nameOf(person);
  const homonym = store.accounts.activeAccounts().some((other) => other.id !== person.id && other.name === person.name);
  return homonym ? `${name} (${person.email})` : name;
};

/** Why the account cannot take or release comments on the project (undefined when it can). A project the account cannot see is not named. */
export function writeRefusal(store: Store, accountId: string, level: AccessLevel | undefined, projectId: string): string | undefined {
  if (level === "write") return undefined;
  const who = `your account (${accountName(store, accountId)})`;
  if (level === undefined) return `Refused: ${who} has no access to this project. Taking or answering a thread needs the Écriture right: ask an admin of the project for it.`;
  const has = level === "comment" ? "the Commentaire right" : "the Lecture right";
  return `Refused: ${who} has ${has} on the project ${JSON.stringify(store.getProject(projectId)?.title ?? "")}. Taking or answering a thread needs the Écriture right: ask an admin of the project for it.`;
}
