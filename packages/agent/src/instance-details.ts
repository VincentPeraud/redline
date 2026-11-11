import { liveSessions } from "./mcp-sessions.js";
import { diagnoseInstallation, probe, type DoctorDeps, type InstallationDiagnosis } from "./doctor.js";
import type { Installation, InstallationsDeps } from "./installations.js";

/** What the Instances tab's left pane shows about one installation: doctor's diagnosis plus what uses it. */
export interface InstanceDetails {
  diagnosis: InstallationDiagnosis;
  installedVersion?: string;
  /** The installation's folder. */
  dir: string;
  /** Absent when the server did not answer (or is too old to tell). */
  serverVersion?: string;
  /** Names of the agents running with it. */
  agents: string[];
  /** The folders known to use it: those of its agents and of its live Claude Code sessions. */
  folders: string[];
  sessions: number;
}

export type InstanceDetailsDeps = Pick<DoctorDeps, "fetchInstance" | "commandVersion" | "hostProtocol" | "timeoutMs"> & Pick<InstallationsDeps, "agentsOf">;

/** Asks the installation's server and gathers what uses it; never rejects because of the server (a refusal or a timeout is part of the diagnosis). */
export async function inspectInstallation(installation: Installation, deps: InstanceDetailsDeps): Promise<InstanceDetails> {
  const [answer, agents] = await Promise.all([probe(installation, deps), deps.agentsOf(installation)]);
  const sessions = liveSessions(installation.dir);
  const folders = [...new Set([...agents.flatMap((agent) => (agent.folder ? [agent.folder] : [])), ...sessions.map((session) => session.folder)])];
  return {
    diagnosis: diagnoseInstallation(answer, { commandVersion: deps.commandVersion, hostProtocol: deps.hostProtocol }),
    installedVersion: installation.version,
    dir: installation.dir,
    serverVersion: answer.info?.version,
    agents: agents.map((agent) => agent.name),
    folders,
    sessions: sessions.length,
  };
}
