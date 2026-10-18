#!/bin/bash
# Create (or reuse) a worktree for a branch and APFS-clone node_modules into it.
# Usage: mkwt.sh <branch> <base-ref> <path>
set -euo pipefail
REPO=/Users/agustinsacco/src/agustinsacco/Phosphor/.phosphor/worktrees/id-like-you-to-review-the-state-of-this
branch=$1 base=$2; case "$3" in /*) path=$3 ;; *) path="$PWD/$3" ;; esac
if [ ! -d "$path/.git" ] && [ ! -f "$path/.git" ]; then
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$REPO" worktree add -q "$path" "$branch"
  else
    git -C "$REPO" worktree add -q -b "$branch" "$path" "$base"
  fi
fi
NM=${NM_SOURCE:-/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715/wt/nm-main}
for d in node_modules apps/desktop/node_modules apps/control/node_modules apps/site/node_modules apps/web/node_modules; do
  if [ ! -e "$path/$d" ]; then
    mkdir -p "$path/$(dirname "$d")"
    cp -cR "$NM/$d" "$path/$d"
  fi
done
git -C "$path" rev-parse HEAD
