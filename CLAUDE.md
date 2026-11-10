# Redline

## Branches

- `develop` is the main branch: day-to-day work is committed there (or on a short-lived branch merged back into `develop`). Base new branches and reviews on `develop`.
- `master` holds what is in production. It only receives merges from `develop`, at each production release (MEP), and only with the user's explicit go. A release is `npm run release -- <x.y.z>` (SemVer 0.x, tag, `CHANGELOG.md`, never pushes): see `docs/releasing.md`. Add a line under `## [Unreleased]` in `CHANGELOG.md` with every merged lot or user-visible fix.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
