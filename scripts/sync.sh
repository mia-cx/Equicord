#!/bin/bash
# Rebases the current branch on upstream/main, force-pushes it to origin, then installs, builds and injects.
# Stops on rebase conflicts: resolve them, run `git rebase --continue`, then run this again.
# Discord loads Equicord from the checkout this runs in, so run it from the checkout you keep.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch upstream
git rebase upstream/main || { echo "Rebase stopped on conflicts. Resolve them, run git rebase --continue, then run this again." >&2; exit 1; }
git push --force-with-lease origin HEAD

pnpm() { npx --yes "$(node -p 'require("./package.json").packageManager')" "$@"; }
pnpm install --frozen-lockfile
pnpm build
pnpm inject
