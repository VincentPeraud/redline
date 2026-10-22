# SQLite for state, content-addressed blobs for files, no Git for content

The server keeps threads, conversations, sessions, agents and the list of versions in SQLite, and stores every file (artboards, manifests, tweaks, DESIGN.md, assets) on disk under its content hash, so an unchanged file is stored once across all versions. A version is a row mapping each path to a hash, and restoring a version only repoints those paths. Git is used for Redline's own source code only, never for user content.

## Considered Options

- **Git repository per project** (the original concept): rejected to keep history, search and restore in one place the server fully controls, without shelling out to Git or exposing commits to the user.
- **Everything as JSON files on disk**: rejected because threads, sessions and agent status need queries and concurrent updates.
- **File contents inside SQLite**: rejected because assets (images, fonts) would bloat the database.
