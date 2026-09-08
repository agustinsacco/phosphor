# `specs/` was two genres wearing one name

`specs/` held 108 markdown files doing two unrelated jobs. `reference/` (14
files) documented how Phosphor behaves **now** — it was the technical manual.
`build/`, `backlog/` and `TRACKER.md` held the opposite: original intent,
unresolved findings, work not yet done. `log/` (83 files) held a third thing
again, dated history.

One folder name covered all of it, so the only way to know whether a file was a
contract or a wish was to check which subfolder it sat in and remember what that
subfolder meant. `specs/README.md` existed precisely to explain the difference,
which is the tell: a folder needing a decoder ring is two folders.

The cost was not hypothetical. Reading a `build/` doc as current is how the
terracotta-vs-Phosphor contradiction survived 20 days, and it is the same class
of error as the light palette drifting for 19
([2026-08-29-phosphor-light-palette-reconcile.md](2026-08-29-phosphor-light-palette-reconcile.md)).

## The split

| Was                | Is now                  | Genre                         |
| ------------------ | ----------------------- | ----------------------------- |
| `specs/reference/` | `docs/`                 | How Phosphor behaves now      |
| `specs/log/`       | `docs/log/`             | Dated history, one per change |
| `specs/backlog/`   | `docs/specs/backlog/`   | Findings not yet resolved     |
| `specs/build/`     | `docs/specs/build/`     | Original pre-code intent      |
| `specs/TRACKER.md` | `docs/specs/TRACKER.md` | Phase state, open boxes       |

`docs/` is now the manual. `docs/specs/` is a running folder of things saved
for later, and it is allowed to be untidy in a way `docs/` is not. `docs/log/`
sits with the docs rather than the specs because it is evidence for them: the
feature docs link into it constantly for _why_, and nothing in it is
outstanding work.

## How the links were moved

Not by find-and-replace. Each of the 176 relative links was resolved to a
repo-absolute path against its **old** location, mapped through the rename
table, then re-relativised from its **new** location. That handles the cases a
regex gets wrong: links that cross genre boundaries in both directions, links
to files that did not move, and `../` chains whose depth changed.

The check that mattered was resolving every link against the filesystem
afterwards. It found 11 breaks a visual scan had missed, all of them in
`CLAUDE.md` and `README.md` rather than in the moved tree.

## Two deliberate non-changes

**Dated log entries still name files by their old `specs/…` paths in prose.**
Their hyperlinks were repointed so they resolve, but the surrounding text was
left alone. These are a record of what was true when they were written, and
editing 83 historical entries to claim a file lived at `docs/` in August would
be false. The mapping table above, and a copy in `docs/README.md`, is the
decoder for anyone following an old path.

**`README.md` got only the two lines this move broke** — the architecture link
and the repo-tree entry. A full rewrite is in flight separately, so touching
more would have been a collision for no gain.

## What is still owed

`docs/` is well organised but thin on diagrams for a folder now billed as the
technical manual. Sequence diagrams for the IPC and RPC paths, a process-model
diagram in `architecture.md`, and a state diagram for session lifecycle are the
obvious gaps. The move had to land first: authoring inside a tree that was
about to be renamed would have conflicted with every line of it.
