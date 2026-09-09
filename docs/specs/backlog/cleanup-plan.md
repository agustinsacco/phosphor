# Cleanup — duplication, dead code, over-export

Originally a full read-through of `src/`, `electron/`, `shared/`, `pi-ext/`
(~39.6k lines) on 2026-08-21, structured as six phases. **Phases 1–5 landed.**
Their bodies were ~500 lines describing work that is now in the code, and the
dated logs are the better record of it:
[foundations and the git layer](../../log/2026-08-21-cleanup-foundations-and-git-layer.md)
and [presentation primitives](../../log/2026-08-21-presentation-primitives.md).
Recover the full original if you need the archaeology:

```bash
git show f6c90c9:docs/specs/backlog/cleanup-plan.md
```

What follows is only what still reproduces. Re-verified 2026-09-09 against the
tree at `f6c90c9` by reading the cited code, not by trusting the old statuses.

| #   | Finding                                                  | Status as of 2026-09-09 |
| --- | -------------------------------------------------------- | ----------------------- |
| C1  | Five symbols exported but used in one file (old phase 6) | open                    |
| C2  | `errorText` not adopted; 18 hand-rolled sites regressed  | open                    |
| C3  | One raw `piCommand` site with no exemption comment       | open                    |
| C4  | `useAsyncAction` not adopted by three modals             | open                    |
| C5  | Phase-4 loose end in `rewind.ts`                         | **fixed** — see below   |

## C1 — over-exported symbols `open`

Still `export`ed and still referenced from exactly one file:
`PiAgentSettings` and `EditableConfigFile` (`electron/pi/agent-settings.ts`),
`canToggleRightPane` (`src/app/useGlobalShortcuts.ts`), `usePaletteStore`
(`src/features/palette/CommandPalette.tsx`), `MCP_SCOPES` (`shared/mcp.ts`).

`JobSender` was on this list and is now **moot** — it is legitimately cross-file
(`electron/headroom/install.ts`).

Deliberately opportunistic: do it while already inside one of those files for
another reason. It needs no tracking beyond this row.

## C2 — `errorText` regressed `open`

Phase 1 added `shared/errors.ts` `errorText` and converted 27 sites. Nothing
enforces it, so 18 hand-rolled `err instanceof Error ? … : String(err)`
expressions have accrued since: `AccountsTab.tsx`, `ClaudeProviderTab.tsx`,
`SkillsPage.tsx`, `NewSkillModal.tsx`, `stores/connectors.ts`,
`electron/pi/connector-auth.ts`, `connector-check.ts`, `auth-status.ts`,
`claude-login.ts`, `model-catalogue.ts`, `src/lib/modelCatalogue.ts`,
`electron/ipc/skills-handlers.ts`.

One of them is not cosmetic: `src/features/chat/ChatImage.tsx` does
`(error as Error).message` on a value that is `unknown`. A thrown string or a
rejected non-Error gives `undefined` there, so the UI renders an empty failure.
That is the correctness case the original plan called out; fix it first.

An ESLint rule would hold the line better than another conversion pass.

## C3 — one uncommented raw `piCommand` `open`

The plan's rule (CLAUDE.md fact 3) is that `window.phosphor.piCommand` is called
through `piCall` / `piCallOk`, and a deliberate exception carries a comment
naming the fact. There are ten raw sites; nine carry that comment.
`src/features/chat/composer/queueActions.ts` does not — so a reader cannot tell
whether it is an intentional exemption or the tenth site that forgot the error
branch. Decide which, and write it down either way.

## C4 — `useAsyncAction` not fully adopted `open`

Phase 5 shipped the hook, and the plan's own note recorded that `MessageItem`,
`ForkPickerModal` and `TreeViewModal` still hand-roll `busy`/`error`. They
still do. Two smaller phase-5 leftovers: 23 inline `<svg>` literals remain
outside `icons.tsx` (down from 45), and `runBashCommand` was never extracted
out of `Composer.tsx`.

## C5 — phase-4 loose end `fixed`

`src/features/chat/rewind.ts` returning `null` on RPC failure now carries the
explicit decision the plan asked for ("Deliberately NOT `piCall` (CLAUDE.md
fact 3)…"). This document claimed it was open until 2026-09-09; it was already
resolved in the code.
