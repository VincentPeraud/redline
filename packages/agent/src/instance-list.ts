import { acceptsProtocol, hostProtocol } from "./host-protocol.js";
import { cliVersion } from "./build-hash.js";
import { addressOf, type FolderResolution, type Installation } from "./installations.js";

/** An installation as the agents screen lists and labels it. */
export interface InstanceEntry {
  id: string;
  name: string;
  serverUrl: string;
  version?: string;
  /** Too old for this redline command: its agents would be refused. */
  tooOld: boolean;
  /** What `redline doctor` finds wrong with it, for the "! n" of the Instances tab. */
  problems?: number;
}

export function instanceEntries(installations: Installation[], protocol = hostProtocol(cliVersion())): InstanceEntry[] {
  return installations.map((installation) => ({ id: installation.id, name: installation.name, serverUrl: installation.serverUrl, version: installation.version, tooOld: !acceptsProtocol(protocol, installation.hostProtocol) }));
}

/** What the "This folder" line says. */
export type FolderLine = { kind: "linked"; instance: string; project?: string } | { kind: "orphan"; address: string } | { kind: "unlinked" };

/** The line for a folder as the resolver found it; `project` is the title of what the link serves, when known. */
export function folderLineOf(resolution: FolderResolution, project?: string): FolderLine {
  if (resolution.kind === "linked") return { kind: "linked", instance: resolution.installation.name, project };
  if (resolution.kind === "orphan") return { kind: "orphan", address: addressOf(resolution.serverUrl) };
  return { kind: "unlinked" };
}

export const addressLabel = (entry: Pick<InstanceEntry, "serverUrl">): string => addressOf(entry.serverUrl);
