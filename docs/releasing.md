# Releasing Redline

## Branches

- `develop`: day-to-day work. Every lot, fix and feature lands here.
- `master`: what is in production. It only moves at a release, through a `--no-ff` merge of `develop` (or a hotfix, see below), and every such merge carries a tag.

## Versions

[Semantic Versioning](https://semver.org/), `0.x` until the CLI, the MCP tools and the agent protocol settle:

- minor (`0.2.0` → `0.3.0`): new features, and any change that breaks the CLI, an MCP tool or the agent protocol (`PROTOCOL_VERSION` bumped);
- patch (`0.3.0` → `0.3.1`): fixes only, nothing breaks.

The version lives in the root `package.json` and every `packages/*/package.json`, all equal. Tags are `v<version>`.

## Changelog

`CHANGELOG.md`, [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Each merged lot or user-visible fix adds a line under `## [Unreleased]` (`Added`, `Changed`, `Fixed`, `Removed`), in the same commit or right after the merge.

## Cutting a release

From `develop`, clean and in sync with `origin`:

```bash
npm run release -- 0.2.0
```

The script (`scripts/release.sh`):

1. refuses unless it runs on `develop`, tracked files are clean, `develop` and `master` equal their `origin` copies, `master` is contained in `develop`, the version is above the last tag and `Unreleased` is not empty;
2. runs `npm test` and `npm run build` (`--skip-tests` as second argument skips the tests, for an exception you can name);
3. commits `Release v0.2.0` on `develop`: the `Unreleased` section becomes `## [0.2.0] - <date>` and every `package.json` gets the version;
4. merges `develop` into `master` (`--no-ff`, in a temporary worktree, so the main checkout stays on `develop`) and tags `v0.2.0`, then fast-forwards `develop` to that merge, so both branches end on the same commit;
5. prints the push and GitHub release commands, and how to undo. **It never pushes.**

Then, after a last look:

```bash
git push origin develop master v0.2.0
gh release create v0.2.0 --title v0.2.0 --notes-file <file printed by the script>
```

Deploy from the tag (`git checkout v0.2.0` on the server, or rebuild the Docker image from it).

## Hotfix

A fix that cannot wait for `develop`:

```bash
git switch -c hotfix/0.2.1 master
# fix, commit, add a line under a new "## [0.2.1] - <date>" in CHANGELOG.md, bump the package.json versions
git switch master && git merge --no-ff hotfix/0.2.1 && git tag -a v0.2.1 -m "Redline v0.2.1"
git switch develop && git merge master
git branch -d hotfix/0.2.1
```

Then push `master`, `develop` and the tag. The release script refuses to run while `master` holds a hotfix that `develop` lacks.
