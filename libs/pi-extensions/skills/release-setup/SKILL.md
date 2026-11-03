---
name: release-setup
description: Set a GitHub repository up for Phosphor's release manager, the lane that reviews, queues, merges and releases pull requests. Use when the user asks to set up, adopt or check release management, or when release mode reports that the repository has no .github/release-manager.md.
---

# Release setup

Phosphor's release manager is a lane in release mode. It validates, reviews,
merges and releases a repository's pull requests, so the lanes that write them
only open them. It runs only in a repository whose base branch carries
`.github/release-manager.md`. This skill writes that file and the rest of the
setup, then opens one pull request for the user to merge. It never switches
release mode on: the user does that.

Work in this lane's checkout. Change nothing on GitHub except what step 5 lists,
and never change repository settings, rulesets or required checks yourself:
recommend the change and let the user make it.

## 0. Look for an earlier setup

Fetch origin. If `origin/BASE` already has `.github/release-manager.md`, or a
setup pull request is open (`gh pr list --state open --search "release-manager.md in:title,body"`),
this is a check, not a first setup: read what is there, report how it differs
from what the steps below would choose, and propose only those changes. Never
add a second "Pull requests" section to AGENTS.md; edit the one there.

## 1. Check access

- `git remote get-url origin` must be a GitHub repository. Note `owner/repo`.
- `gh auth status` must be signed in. `gh api repos/OWNER/REPO --jq .permissions.push`
  must be `true`: the release manager pushes fix commits and its lease ref.
- `gh api repos/OWNER/REPO` gives `default_branch`, `visibility` and the merge
  settings: `allow_squash_merge`, `allow_merge_commit`, `allow_rebase_merge`,
  `allow_auto_merge`, `delete_branch_on_merge`.

Stop and tell the user if any of these fail. The steps below read the
repository; only step 5 writes to it.

## 2. Read how the repository merges and releases

- The rules on the base, readable with push access:
  `gh api repos/OWNER/REPO/rules/branches/BASE` lists every active ruleset rule
  (required status checks, required approvals). Classic branch protection:
  `gh api repos/OWNER/REPO/branches/BASE --jq .protected`. The full protection
  and ruleset details need admin access; a 403 or 404 there means **unknown**,
  not "none". Say which you could not read, and recommend rather than assume.
- Workflows in `.github/workflows/`: what runs on pull requests, what runs on
  pushes to the base, and which workflows release (`workflow_run`, tags,
  `release:`). Note any `concurrency` with `cancel-in-progress` on the base: a
  second merge then cancels the first one's CI, so merges must wait for it.
- The commands a change must pass locally: package scripts, a Makefile, the
  validate or check commands that AGENTS.md or CONTRIBUTING name.
- AGENTS.md, CLAUDE.md and the repository's skills (`.pi/skills`,
  `.claude/skills`, `.agents/skills`): the review rules the manager should apply.
- Paths a person should merge: CI and release configuration, update and
  signing code, auth, database migrations, secrets handling.
- Recent history: `gh pr list --state merged --limit 30 --json number,mergedAt,mergedBy`
  shows how often pull requests merge and who merges them.

## 3. Choose the policy

| Key              | Meaning                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`           | The branch pull requests merge into. Usually the default branch.                                                                              |
| `merge`          | `squash`, `merge` or `rebase`. Must be allowed in the settings.                                                                               |
| `required_check` | The check that gates a merge, from the ruleset or protection.                                                                                 |
| `validate`       | The local command that must pass after the manager merges the base into a branch.                                                             |
| `freshness`      | `local`: when the base moved since a PR's CI, merge the base in a scratch worktree and run `validate` before merging. `ci`: rerun CI instead. |
| `batch`          | Pull requests per merge. Keep `1`.                                                                                                            |
| `human_only`     | Globs the manager validates and reviews but never merges.                                                                                     |

Make the assumptions a person would, and write each one down in the pull
request description. Ask only when a wrong guess would merge something unsafe.

## 4. Write the files

`.github/release-manager.md`:

```markdown
---
base: main
merge: squash
required_check: CI result
validate: npm run typecheck && npm run lint && npm test
freshness: local
batch: 1
human_only:
  - .github/**
  - <paths from step 2>
---

Review each pull request against AGENTS.md. <Repository-specific review rules,
and which skills to use for which kind of change.>
```

The manager re-reads this file from origin's base on every pass, and never
merges a change to it, so later edits go through a pull request the user merges.

Add this section to the repository's AGENTS.md (or CLAUDE.md, whichever the
repository uses), adapted to its words:

```markdown
## Pull requests

Before you mark a pull request ready, give a fresh reviewer the diff and its
purpose, fix what it finds, and record the review in a "## Review" section of
the description. Open the pull request ready when the work is done, and keep it
a draft while you still have commits to push. The release manager
(.github/release-manager.md) validates, merges and releases it: don't merge your
own pull request or wait on CI. It may push merge or fix commits to your branch,
so pull before you push. If your pull request already merged, open a new one.
Label it `rm:hold` to keep it out of the queue; `rm:blocked` means it waits on
its lane or a person, as its status comment says.
```

## 5. Open the setup pull request

1. Create the labels, which are safe to repeat:
   `gh label create rm:hold --force --color c5def5 --description "Release manager: wait"`,
   `gh label create rm:priority --force --color d93f0b --description "Release manager: merge first"`,
   `gh label create rm:blocked --force --color b60205 --description "Release manager: waits on its lane or a person"`.
2. Create the "Release queue" issue unless one exists
   (`gh issue list --search '"Release queue" in:title' --state open`):
   `gh issue create --title "Release queue" --body "The release manager keeps this issue current."`,
   then `gh issue pin NUMBER`. A repository pins at most three issues; if the
   pin fails, leave the issue unpinned and say so. The manager keeps it current.
3. Commit the two files on a new branch from the base
   (`git fetch origin && git switch -c release-setup origin/BASE`), never on
   this lane's own branch, push it, and open the pull request. Its description
   lists what you found, each choice and assumption, what you could not read,
   and the settings you recommend the user change.

## 6. Tell the user what is left

- Merge the setup pull request.
- Start a lane from the updated base on the Host that should run the manager,
  and switch on **Release** in its composer (or send `/phosphor-release on`).
  One lane per repository holds the release lease; a second one waits on standby.
- Any recommended setting changes, such as a required check or the merge methods.
