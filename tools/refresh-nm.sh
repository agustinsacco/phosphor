#!/bin/bash
# Replace a worktree's node_modules with clones from the current golden install.
set -euo pipefail
NM=${NM_SOURCE:-/Users/agustinsacco/.pi/agent/scratch/job-6fb76f10c18f468f8e05e46c677cc715/wt/nm-main}
cd "$1"
for d in node_modules apps/desktop/node_modules apps/control/node_modules apps/site/node_modules apps/web/node_modules; do
  rm -rf "$d"; mkdir -p "$(dirname "$d")"; cp -cR "$NM/$d" "$d"
done
