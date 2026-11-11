import { addressOf, currentInstallation, findInstallation, listInstallations, resolveFolder, type Installation, type InstallationsDeps } from "./installations.js";
import { linkFolderToServer } from "./link.js";

export interface LinkCommand {
  configDir: string;
  folder: string;
  /** `redline link <instance>`: a name, an id or an address. */
  wanted?: string;
  home: string;
  fetchInstance: InstallationsDeps["fetchInstance"];
  /** Titles of the projects of a folder's link, for the question before switching it. */
  projectNames(installation: Installation, projectIds: string[]): Promise<string[]>;
  ask(question: string): Promise<string>;
  out(line: string): void;
}

const shown = (path: string, home: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

const pad = (text: string, width: number) => text.padEnd(width);

/** What `redline agent` says of a folder linked to an address with no installation here (agent.html). */
export const orphanLines = (serverUrl: string): string[] => [`This folder's link file names ${addressOf(serverUrl)}, which is not installed on this computer.`, `  Install it: redline setup ${serverUrl}`];

/** Lists the instances (name, address, version) and asks which one; the number or the name works. */
export async function askInstallation(installations: Installation[], { ask, out }: Pick<LinkCommand, "ask" | "out">): Promise<Installation> {
  const names = Math.max(...installations.map((i) => i.name.length)) + 2;
  const addresses = Math.max(...installations.map((i) => addressOf(i.serverUrl).length)) + 3;
  installations.forEach((installation, index) =>
    out(`  ${index + 1}. ${pad(installation.name, names)}${pad(addressOf(installation.serverUrl), addresses)}${installation.version ? `v${installation.version}` : ""}`.trimEnd()),
  );
  for (;;) {
    const answer = (await ask("Pick an instance: ")).trim();
    const picked = installations[Number(answer) - 1] ?? findByName(installations, answer);
    if (picked) return picked;
  }
}

const findByName = (installations: Installation[], answer: string) => installations.find((i) => answer !== "" && i.name.toLowerCase() === answer.toLowerCase());

/**
 * `redline link [<instance>]`: links the folder to an instance, with no project and no agent. A folder already linked to
 * another instance (or to one not installed here) is switched only on a "y".
 */
export async function runLink({ configDir, folder, wanted, home, fetchInstance, projectNames, ask, out }: LinkCommand): Promise<void> {
  const all = await Promise.all(listInstallations(configDir).map((installation) => currentInstallation(configDir, installation, fetchInstance)));
  if (all.length === 0) throw new Error("No Redline instance is set up on this computer. Run `redline setup <address>` first.");
  let target: Installation;
  let only = false;
  if (wanted) {
    const found = findInstallation(configDir, wanted);
    if (!found) throw new Error(`${wanted} is not installed on this computer. Installed: ${all.map((i) => i.name).join(", ")}. Install it with \`redline setup <address>\`.`);
    target = all.find((i) => i.id === found.id)!;
  } else if (all.length === 1) {
    [target] = all;
    only = true;
  } else target = await askInstallation(all, { ask, out });

  const here = resolveFolder(configDir, folder);
  const found = "root" in here ? here : undefined;
  const ownLink = found && found.root === folder ? found : undefined;
  if (ownLink?.kind === "linked" && ownLink.installation.id === target.id) {
    out(`✓ Already linked to ${target.name} (${addressOf(target.serverUrl)}). Nothing changed.`);
    return;
  }
  if (ownLink?.kind === "linked" && ownLink.projectIds.length > 0) {
    const titles = await projectNames(ownLink.installation, ownLink.projectIds).catch(() => []);
    const served = titles.length > 0 ? titles.join(", ") : `${ownLink.projectIds.length} project${ownLink.projectIds.length === 1 ? "" : "s"}`;
    out(`This folder is linked to ${ownLink.installation.name} and serves ${served} there. Link it to ${target.name} instead?`);
    if (!(await confirm(ask, `Its agent stops serving ${served} from this folder. (y/N): `))) return void out("Nothing changed.");
  } else if (ownLink?.kind === "linked") {
    out(`This folder is linked to ${ownLink.installation.name} (no project yet). Link it to ${target.name} instead?`);
    if (!(await confirm(ask, `Link it to ${target.name} instead? (y/N): `))) return void out("Nothing changed.");
  } else if (ownLink?.kind === "orphan") {
    out(`This folder's link file names ${addressOf(ownLink.serverUrl)}, which is not installed on this computer.`);
    if (!(await confirm(ask, `Link it to ${target.name} instead? (y/N): `))) return void out("Nothing changed.");
  } else if (found?.kind === "linked" && found.root !== undefined && found.installation.id !== target.id) {
    out(`The parent folder ${shown(found.root, home)} is linked to ${found.installation.name}. Link this folder to ${target.name} instead, below it?`);
    if (!(await confirm(ask, `Link only this folder to ${target.name}? (y/N): `))) return void out("Nothing changed.");
  } else if (found?.kind === "orphan") {
    out(`The parent folder ${shown(found.root, home)} has a link file naming ${addressOf(found.serverUrl)}, which is not installed on this computer.`);
    if (!(await confirm(ask, `Link only this folder to ${target.name}? (y/N): `))) return void out("Nothing changed.");
  }
  linkFolderToServer(folder, target.serverUrl);
  if (only) out(`✓ Linked to ${target.name}, the only instance on this computer. No agent started.`);
  else if (ownLink) out(`✓ Linked to ${target.name}. No project yet: redline agent picks one.`);
  else {
    out(`✓ ${shown(folder, home)} linked to ${target.name} (${addressOf(target.serverUrl)}). No agent started.`);
    out("  Open Claude Code sessions here: type /mcp and reconnect redline.");
  }
}

export async function confirm(ask: LinkCommand["ask"], question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await ask(question)).trim());
}
