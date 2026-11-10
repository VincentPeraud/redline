#!/usr/bin/env bash
# Prepares a Redline release locally: checks, version bump, changelog,
# merge of develop into master and an annotated tag. Never pushes.
# Usage: npm run release -- <x.y.z> [--skip-tests]
# Process: docs/releasing.md
set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }

version="${1:-}"
skip_tests="${2:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "give a version like 0.2.0 (no leading v)"
[[ -z "$skip_tests" || "$skip_tests" == "--skip-tests" ]] || die "unknown option: $skip_tests"
tag="v$version"

cd "$(git rev-parse --show-toplevel)"

# 1. Where we stand
[[ "$(git branch --show-current)" == "develop" ]] || die "run it from develop"
git diff --quiet && git diff --cached --quiet || die "commit or stash your changes first"
git fetch -q origin develop master --tags
git rev-parse -q --verify refs/heads/master >/dev/null || git branch -q master origin/master
[[ "$(git rev-parse develop)" == "$(git rev-parse origin/develop)" ]] \
  || die "develop and origin/develop differ: push or pull first"
[[ "$(git rev-parse master)" == "$(git rev-parse origin/master)" ]] \
  || die "master and origin/master differ: sort that out first"
git merge-base --is-ancestor master develop \
  || die "master has commits develop lacks (a hotfix?): merge master into develop first"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"

last="$(git tag -l 'v[0-9]*' --sort=-v:refname | head -1)"
if [[ -n "$last" ]]; then
  highest="$(printf '%s\n%s\n' "${last#v}" "$version" | sort -V | tail -1)"
  [[ "$highest" == "$version" ]] || die "$tag is not above the last release $last"
fi

notes="$(awk '/^## \[Unreleased\]/{on=1; next} /^## \[/{on=0} on' CHANGELOG.md | sed '/./,$!d')"
[[ -n "$(printf '%s' "$notes" | tr -d '[:space:]')" ]] \
  || die "the Unreleased section of CHANGELOG.md is empty"

# 2. Green build
if [[ "$skip_tests" == "--skip-tests" ]]; then
  echo "release: tests skipped (--skip-tests)"
else
  npm test
fi
npm run build

# 3. Release commit on develop
today="$(date +%Y-%m-%d)"
tmp_changelog="$(mktemp)"
awk -v v="$version" -v d="$today" '
  /^## \[Unreleased\]/ && !done { print; print ""; print "## [" v "] - " d; done=1; next }
  { print }
' CHANGELOG.md > "$tmp_changelog"
mv "$tmp_changelog" CHANGELOG.md

npm version "$version" --no-git-tag-version --workspaces --include-workspace-root >/dev/null
git add CHANGELOG.md package.json package-lock.json packages/*/package.json
git commit -q -m "Release $tag"

# 4. Merge into master and tag, in a temporary worktree (the main checkout stays on develop)
worktree="$(mktemp -d)"
cleanup() { git worktree remove --force "$worktree" 2>/dev/null || true; }
trap cleanup EXIT
git worktree add -q "$worktree" master
git -C "$worktree" merge -q --no-ff develop -m "Release $tag"
git -C "$worktree" tag -a "$tag" -m "Redline $tag"
# develop takes the merge commit too, so the next release starts from master
git merge -q --ff-only master

notes_file="$(mktemp -t "redline-$tag")"
printf '%s\n' "$notes" > "$notes_file"

cat <<EOF

Release $tag is ready locally (nothing pushed):
  develop  $(git log -1 --format='%h %s' develop)
  master   $(git log -1 --format='%h %s' master)
  tag      $tag

Publish it:
  git push origin develop master $tag
  gh release create $tag --title "$tag" --notes-file "$notes_file"

Undo it before pushing:
  git tag -d $tag && git branch -f master origin/master && git reset --keep origin/develop
EOF
