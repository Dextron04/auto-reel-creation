#!/bin/sh
set -eu
umask 077

repo=${1:?"usage: update-production-checkout.sh REPO [BRANCH]"}
branch=${2:-main}
remote=${DEPLOY_REMOTE:-origin}
backup_root=${DEPLOY_BACKUP_ROOT:-"${repo}.deploy-backups"}

cd "$repo"
git fetch --prune "$remote" "$branch"
remote_ref="$remote/$branch"

repo_root=$(pwd -P)
mkdir -p "$backup_root"
backup_root=$(cd "$backup_root" && pwd -P)
case "$backup_root/" in
  "$repo_root/"*)
    echo "DEPLOY_BACKUP_ROOT must be outside the production repository" >&2
    exit 1
    ;;
esac

if git cat-file -e "$remote_ref:.env.prod" 2>/dev/null; then
  echo "Refusing deployment because $remote_ref tracks .env.prod" >&2
  exit 1
fi

has_tracked_changes=false
if ! git diff --quiet HEAD --; then
  has_tracked_changes=true
fi

has_local_commits=false
if ! git merge-base --is-ancestor HEAD "$remote_ref"; then
  has_local_commits=true
fi

if [ "$has_tracked_changes" = true ] || [ "$has_local_commits" = true ]; then
  backup="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$backup"
  git status --short --branch > "$backup/status.txt"
  git diff HEAD --binary > "$backup/tracked-changes.patch"
  git bundle create "$backup/local-commits.bundle" --all
  test -s "$backup/local-commits.bundle"
  git bundle verify "$backup/local-commits.bundle" >/dev/null
  test -f "$backup/tracked-changes.patch"
  if [ -f .env.prod ]; then
    cp .env.prod "$backup/env.prod"
    chmod 600 "$backup/env.prod"
    cmp -s .env.prod "$backup/env.prod"
  fi
  echo "Saved production checkout backup to $backup"
  git checkout -f "$branch"
  git reset --hard "$remote_ref"
  if [ -f "$backup/env.prod" ]; then
    cp "$backup/env.prod" .env.prod
    chmod 600 .env.prod
    cmp -s .env.prod "$backup/env.prod"
  fi
else
  git checkout "$branch"
  git merge --ff-only "$remote_ref"
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$remote_ref")" ]; then
  echo "Production checkout did not align to $remote_ref" >&2
  exit 1
fi

if ! git diff --quiet HEAD --; then
  echo "Production checkout still has tracked changes after alignment" >&2
  exit 1
fi

if [ -n "${DEPLOY_COMMIT:-}" ] && ! git merge-base --is-ancestor "$DEPLOY_COMMIT" HEAD; then
  echo "Production checkout does not contain $DEPLOY_COMMIT" >&2
  exit 1
fi

echo "Production checkout aligned to $(git rev-parse --short HEAD)."
