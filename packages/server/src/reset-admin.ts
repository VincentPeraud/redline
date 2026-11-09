import { Store } from "./store.js";

/** `reset-admin`: writes a password link for the oldest active admin, for the case where nobody can sign in. Returns the process exit code. */
export function resetAdmin(options: { dataDir: string; publicUrl?: string; log: (line: string) => void; error: (line: string) => void }): number {
  const store = new Store(options.dataDir);
  try {
    const admin = store.accounts.firstActiveAdmin();
    if (!admin) {
      options.error("No admin account yet: open the setup link written to the logs at start-up to create the first one.");
      return 1;
    }
    const { token } = store.accounts.issuePasswordLink(admin.id);
    const base = (options.publicUrl ?? "http://localhost:3000").replace(/\/$/, "");
    options.log(`Password link for ${admin.name} (${admin.email}), valid 24 hours, single use:`);
    options.log(`${base}/#/mot-de-passe/${token}`);
    return 0;
  } finally {
    store.close();
  }
}
