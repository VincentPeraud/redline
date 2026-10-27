// SQLite helper of the backup scripts. Runs inside the Redline container (`node - <mode> <args>` on stdin) or on a host with node.
//   snapshot <source.db> <destination.db>   consistent copy through SQLite's backup API, checked before it replaces the destination
//   verify <database.db>                    integrity and table check
// Both print the number of projects on success and exit 1 with a message on stderr otherwise.
const Database = require("better-sqlite3");
const { existsSync, renameSync, rmSync } = require("node:fs");

const expectedTables = ["people", "projects", "pages", "versions", "threads", "settings", "agents"];

function verify(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`integrity_check failed: ${integrity}`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const missing = expectedTables.filter((name) => !tables.has(name));
    if (missing.length > 0) throw new Error(`missing tables: ${missing.join(", ")}`);
    return db.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
  } finally {
    db.close();
  }
}

async function snapshot(source, destination) {
  const partial = `${destination}.partial`;
  rmSync(partial, { force: true });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(partial);
  } finally {
    db.close();
  }
  try {
    // The copy is a standalone file: a read-only mount cannot host the WAL side files of a WAL database.
    const copy = new Database(partial);
    copy.pragma("journal_mode = DELETE");
    copy.close();
    const projects = verify(partial);
    for (const suffix of ["-wal", "-shm"]) rmSync(destination + suffix, { force: true });
    renameSync(partial, destination);
    return projects;
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

async function main() {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "snapshot" && first && second) return snapshot(first, second);
  if (mode === "verify" && first && existsSync(first)) return verify(first);
  throw new Error("usage: snapshot <source.db> <destination.db> | verify <database.db>");
}

main().then(
  (projects) => console.log(projects),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
