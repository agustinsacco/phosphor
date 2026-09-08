# Cleanup plan — complexity, duplication, dead code

Full read-through of `src/`, `electron/`, `shared/`, `pi-ext/` (~39.6k lines) on
2026-08-21. Baseline at the time of writing: `SKIP_E2E=1 npm run validate` →
typecheck / lint / format / unit all PASS.

The codebase is in good shape structurally — the IPC handler layer is thin and
uniform, `PaneShell` / `usePackageJob` / `reducer.ts` are well-factored, and the
comments carry real history. The findings below are almost entirely _horizontal_
duplication: the same shape re-implemented 4–9 times because each occurrence was
added by a different feature, plus a handful of genuinely dead symbols.

Nothing here changes behavior. Every phase is independently landable and
independently revertable.

## Status

**Re-verified 2026-08-27** against the tree at `4c02e13`, by checking for each
phase's artifacts in the code rather than trusting this document. **Phases 1–5
have landed; only phase 6 and one loose end remain.**

| Phase                           | Status       | Evidence                                                                                                                                                       |
| ------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Dead code and free wins     | **landed**   | `shared/errors.ts`, the `subscribe()` helper in `electron/preload.ts` · [log](../../log/2026-08-21-cleanup-foundations-and-git-layer.md)                       |
| 2 — Main-process git and config | **landed**   | `electron/fs/git-exec.ts` (`git`, `dirtyCount`, `abortMergeAndCollectConflicts`), `electron/pi/json-config.ts` · same log                                      |
| 3 — Store slice pattern         | **landed**   | `src/stores/keyedSlice.ts` + test, commit `95dea43` (#40)                                                                                                      |
| 4 — Enforce the `piCall` rule   | **landed\*** | The 9 remaining raw `piCommand` sites are exactly this plan's "leave, with a comment" set; commit `95dea43` (#40)                                              |
| 5 — Renderer presentation layer | **landed**   | `components/form.tsx`, `icons.tsx`, `useAsyncAction.ts` · [log](../../log/2026-08-21-presentation-primitives.md)                                               |
| 6 — Over-exported symbols       | **open**     | Deliberately opportunistic. `PiAgentSettings`, `JobSender`, `canToggleRightPane`, `usePaletteStore`, `MCP_SCOPES` are all still exported and still single-file |

\* One loose end in phase 4: `src/features/chat/rewind.ts:43`
(`entryIdForUserMessageOrdinal`) still returns `null` on RPC failure with no
comment saying the silence is intended. The plan asked for a decision there and
it never got one. Everything else in the triage list was either converted or
carries its exemption comment — `Composer.tsx` names CLAUDE.md fact 3 explicitly.

Phase 6 needs no separate tracking beyond this row: it is by design something
you do while already inside a file for another reason.

---

## Summary of findings

| #   | Finding                                                                | Sites                 | Phase |
| --- | ---------------------------------------------------------------------- | --------------------- | ----- |
| 1   | 4 copies of the git `execFile` wrapper, 4 divergent `dirtyCount` impls | 4 files               | 2     |
| 2   | 5 copies of the keyed-slice store patch/empty/accessor pattern         | 5 stores              | 3     |
| 3   | 9 near-identical preload subscription methods                          | 1 file                | 1     |
| 4   | Duplicated Tailwind button class strings                               | 37 across 14 files    | 5     |
| 5   | Inline `<svg>` literals outside `icons.tsx`                            | 45 (4 glyphs 3× each) | 5     |
| 6   | Error-normalization expression repeated                                | 27                    | 1     |
| 7   | Modal panel chrome repeated                                            | 6                     | 5     |
| 8   | `busy`/`error` async-action state machines                             | 6                     | 5     |
| 9   | JSON "read with health" implemented 3×                                 | 3                     | 2     |
| 10  | Direct `piCommand` bypassing `piCall` (violates CLAUDE.md #3)          | 21 vs 16              | 4     |
| 11  | Dead code (a file, 2 functions, a re-export, a stale comment)          | —                     | 1     |

---

## Phase 1 — Dead code and free wins

Zero-risk deletions and one mechanical extraction. Land first so later phases
touch less code.

### 1.1 Delete dead code

- **`src/features/chat/blocks/ThinkingBlock.tsx`** (44 lines) — zero importers.
  Superseded: thinking now renders in `items/ActivityGroup.tsx` as
  hover/pin-revealed `ThoughtOnlyRow`s, a different design from this file's
  collapsible "Thought process" disclosure. This is the only file in
  `src/features/chat/blocks/`, so **delete the directory**.
- **`src/features/sessions/Sidebar.tsx:11`** —
  `export { relativeTimeShort as relativeTime } from '@/lib/time'`. A component
  file acting as a barrel for a lib function, _and_ the alias renames it to a
  different real function's name (`relativeTime` also exists in `lib/time.ts`
  and behaves differently). Its one consumer is
  `src/features/artifacts/ArtifactsPane.tsx:13`, which currently reaches across
  features to get it. Point ArtifactsPane at `@/lib/time` and drop the
  re-export.
  - **Decide while doing this:** ArtifactsPane wants the _short_ format, so it
    should import `relativeTimeShort`. Keeping the current name would silently
    switch it to the long format. Import `relativeTimeShort` and use it
    directly — no alias.
- **`src/features/sessions/Sidebar.tsx:748`** — the doc comment
  `/** Rename a disk or live session, then refresh the sidebar listing. */` sits
  above `SectionLabel`, orphaned when its function moved to `sidebarActions.ts`.
  Delete it.

### 1.2 One error-normalization helper

27 sites hand-roll the same conversion, in two spellings:

- `err instanceof Error ? err.message : String(err)` — 13 sites
  (`McpTab.tsx` ×3, `MergeWorktreeModal.tsx` ×2, `terminal.ts`,
  `RemoveWorktreeModal.tsx`, `BranchPicker.tsx`, `usePackageJob.ts`,
  `ExtensionsTab.tsx`, `pty-manager.ts`, `git-worktrees.ts`, `git-sync.ts`)
- `(error as Error).message` — 14 sites (an unchecked cast that throws on a
  non-Error rejection, which `piCommand` rejections can be)

Add to `src/lib/format.ts` (renderer) and mirror in a main-process util:

```ts
/** Message from an unknown thrown value, never a cast. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
```

Replace all 27. The `(error as Error).message` sites are a real (if unlikely)
correctness fix, not just tidiness.

### 1.3 Collapse the preload subscription boilerplate

`electron/preload.ts` has 9 methods that are the same 4 lines with a different
channel and payload type — ~70 lines. Extract once:

```ts
function subscribe<A extends unknown[]>(
  channel: string,
  listener: (...args: A) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, ...args: A): void => listener(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}
```

Each method becomes a one-liner, e.g.
`onPtyData: (ptyId, l) => subscribe(`pty:data:${ptyId}`, l)`. The `PhosphorApi`
interface in `shared/ipc.ts` is unchanged, so this is invisible to the renderer
and to `mockPhosphor.ts`.

**Verify phase 1:** `npm run typecheck && npm run lint && npm test`, plus
`npm run test:e2e` (preload is in the IPC path).

---

## Phase 2 — Main process: git and config-file layers

### 2.1 One git runner (`electron/fs/git-exec.ts`)

`git-info.ts`, `git-service.ts`, `git-sync.ts` and `git-worktrees.ts` each
declare a private `git(cwd, args)` around `promisify(execFile)`, with limits
that have drifted apart for no stated reason:

| File               | timeout | maxBuffer     | trims? | tolerates failure? |
| ------------------ | ------- | ------------- | ------ | ------------------ |
| `git-info.ts`      | 10s     | default (1MB) | yes    | no                 |
| `git-service.ts`   | 20s     | 64MB          | no     | `allowFail` flag   |
| `git-sync.ts`      | 30s     | 16MB          | no     | no                 |
| `git-worktrees.ts` | 30s     | 16MB          | no     | no                 |

The 1MB default in `git-info.ts` is the one worth noting: `git status
--porcelain` on a very large dirty tree can exceed it, and the `catch` swallows
it as "no dirty count".

Extract one module exporting `git(cwd, args, opts?)` with a single documented
default (30s / 64MB) and an explicit `allowFail` option. Keep the _semantics_
each caller relies on — `git-info.ts` trims, so either keep trimming there or
make trimming an explicit option rather than silently changing 4 call sites.

### 2.2 One `dirtyCount`

Four implementations, subtly different on trailing-newline handling:

- `git-sync.ts:33` — `status ? status.split('\n').length : 0`
- `git-info.ts:47` and `:106` — `.split('\n').filter(Boolean).length`
- `git-worktrees.ts:109` — `status.trim() ? status.trim().split('\n').length : 0`
- `git-worktrees.ts:375` — `status.split('\n').length` (on an already-trimmed
  string)

Move `dirtyCount(cwd)` into `git-exec.ts` with the `trim()`-then-`filter(Boolean)`
behavior (the only one that is correct for both empty and trailing-newline
output) and use it in all 5 places.

### 2.3 Share the worktree porcelain parser

`git-sync.ts:203 heldBy()` hand-parses `git worktree list --porcelain` line by
line, while `git-worktrees.ts:55` already exports a tested `parseWorktreeList()`
that produces exactly the `{path, branch}` pairs `heldBy` needs. Rewrite
`heldBy` on top of it:

```ts
const held = parseWorktreeList(await git(repoPath, ['worktree', 'list', '--porcelain'])).find(
  (w) => w.branch === branch && w.path !== repoPath,
)
return held?.path ?? null
```

### 2.4 Share the merge-conflict abort

`git-worktrees.ts:377-393` (`mergeBranch`) and `git-sync.ts:152-168`
(`updateFromMain`) contain the same try/catch: collect `--diff-filter=U` names,
`merge --abort`, swallow both failures. Extract
`abortMergeAndCollectConflicts(cwd): Promise<string[]>` into `git-exec.ts`.

### 2.5 One JSON "read with health"

Three implementations of "read a JSON config, tolerate missing, report
malformed":

- `electron/pi/agent-settings.ts:84 readJson()` — async, returns
  `{settings, exists, malformed, error?}`
- `electron/pi/mcp-config.ts:60 readMcpFileAt()` — async, same idea wrapped in
  `McpFileState` + `raw`
- `electron/pi/packages.ts:88 readPackagesArray()` — **sync**, silently returns
  `[]` on both missing and malformed

Extract `readJsonFile(path): Promise<{ value: Record<string, unknown>; exists: boolean; malformed: boolean; error?: string }>`
into `electron/pi/json-config.ts`. `agent-settings` and `mcp-config` wrap it
directly. `packages.ts` is sync inside `listPackages()`, which is called from a
handler that can be async — convert `listPackages` to async and `await` it in
`packages-handlers.ts` (the IPC contract already returns a Promise, so
`shared/ipc.ts` is unchanged).

**Verify phase 2:** existing tests cover this well —
`electron/fs/git-sync.test.ts`, `git-worktrees.test.ts`,
`electron/pi/{agent-settings,mcp-config,packages}.test.ts`. Add a case
for `dirtyCount` on trailing-newline output, since that behavior is being
unified rather than preserved verbatim.

---

## Phase 3 — Store slice pattern

Five stores independently invented the same three-part pattern: a frozen empty
value, a `patch(state, key, update)` helper, and a `slice(state, key)` accessor.

| Store          | Empty                   | Patch fn               | Accessor           |
| -------------- | ----------------------- | ---------------------- | ------------------ |
| `files.ts`     | `EMPTY_WORKSPACE_FILES` | `patchWorkspace`       | `workspaceFiles`   |
| `terminal.ts`  | `EMPTY_TERMINALS`       | `patchSession`         | `sessionTerminals` |
| `layout.ts`    | `CLOSED`                | `patch`                | `sessionPanes`     |
| `chat.ts`      | `emptySession()`        | `patchSession`         | — (inline)         |
| `worktrees.ts` | `EMPTY_REPO`            | inline in `syncRemote` | `repoWorktrees`    |

Add `src/stores/keyedSlice.ts`:

```ts
/** Frozen empty + patch + read for a `Record<key, Slice>` store field. */
export function keyedSlice<S>(empty: S) {
  const frozen = Object.freeze(empty)
  return {
    read: (map: Record<string, S>, key: string | null | undefined): S =>
      (key ? map[key] : undefined) ?? frozen,
    patch: (map: Record<string, S>, key: string, update: (current: S) => S) => ({
      ...map,
      [key]: update(map[key] ?? frozen),
    }),
    drop: (map: Record<string, S>, key: string) => {
      if (!(key in map)) return map
      const next = { ...map }
      delete next[key]
      return next
    },
  }
}
```

**Keep the existing exported accessor names** (`workspaceFiles`,
`sessionTerminals`, `sessionPanes`, `repoWorktrees`) as thin wrappers — they are
imported across ~15 components and the CLAUDE.md "shared frozen empty value"
rule is written in terms of them. This phase changes the _implementation_, not
the store API.

Two things this phase must **not** flatten:

- `layout.ts:81 patch()` also resolves the active session when `sessionId` is
  omitted, and returns `state` unchanged when there is none. That is
  layout-specific; keep it as a wrapper around the shared `patch`.
- `chat.ts` slices default via `emptySession()` (a fresh object, not a frozen
  singleton) because `ChatSession` holds mutable arrays. Either keep `chat.ts`
  out of this phase or pass a factory — do **not** hand it a frozen singleton.

### 3.1 Multi-record `remove` in the same pass

`artifacts.ts:194` deletes from 4 records by hand, `sessions.ts:461` from 3.
Both have comments recording bugs where a record was forgotten. With
`keyedSlice.drop` these become:

```ts
remove: (sessionId) =>
  set((s) => ({
    bySession: drop(s.bySession, sessionId),
    selected: drop(s.selected, sessionId),
    selectedVersion: drop(s.selectedVersion, sessionId),
    unseen: drop(s.unseen, sessionId),
  })),
```

### 3.2 `files.ts` open-file patching

`src/stores/files.ts` contains
`openFiles: w.openFiles.map((f) => f.path === path ? { ...f, … } : f)`
**8 times**. Add a local helper:

```ts
const patchFile = (w: WorkspaceFiles, path: string, fields: Partial<OpenFile>): WorkspaceFiles => ({
  ...w,
  openFiles: w.openFiles.map((f) => (f.path === path ? { ...f, ...fields } : f)),
})
```

`updateBuffer` computes `dirty` from `content`, so it passes a function rather
than a literal — give `patchFile` a `Partial<OpenFile> | ((f: OpenFile) => Partial<OpenFile>)`
second parameter, or leave that one call site alone. Prefer leaving it alone;
7 of 8 collapse cleanly and the 8th stays readable.

**Verify phase 3:** `src/stores/*.test.ts` already covers cleanup
(`sessionCleanup.test.ts`, `filesRelease.test.ts`, `suspendSession.test.ts`,
`terminal.test.ts`, `layout.test.ts`). Run e2e — session lifecycle is in scope.

---

## Phase 4 — Enforce the `piCall` rule

`CLAUDE.md` fact #3 says RPC goes through `src/lib/rpc.ts` because "half the
original call sites forgot [the error branch]". The codebase is currently
**majority non-compliant**: 21 direct `window.phosphor.piCommand` sites vs 16
`piCall`/`piCallOk`.

Not all 21 are violations. Triage:

**Fix — silently drops failures:**

- `src/features/chat/RetryStrip.tsx:23` — `await window.phosphor.piCommand(sessionId,
{ type: 'abort_retry' })` with **no error branch at all**. → `piCallOk`.
- `src/features/sessions/sidebarActions.ts:28` — checks
  `response.success && response.data?.cancelled`, so the `!response.success`
  branch vanishes: a failed clone looks identical to a successful one. →
  `piCall`, then check `cancelled` on the returned data.

**Fix — hand-rolls exactly what `piCall` does:**

- `src/features/chat/rewind.ts:13` — 4 lines reproducing `piCall`'s error path.
- `src/features/chat/rewind.ts:43` (`entryIdForUserMessageOrdinal`) — returns
  `null` on failure with no report; decide whether silence is intended here and
  either use `piCall` or add a comment saying why not.
- `src/features/chat/ForkPickerModal.tsx:20,32,46`.
- `src/features/chat/Composer.tsx:209` (the `prompt` send).

**Leave, with a comment saying why:**

- `src/stores/sessions.ts:101-106` — `bootstrapSession` needs the raw envelope
  for `Promise.allSettled` and deliberately tolerates per-command failure on old
  pi builds. The file already explains this; add one line naming the exemption.
- `src/stores/sessions.ts:173` `refreshStats` — fires on every stream event;
  surfacing a chat error per token batch would be worse than silence.
- `src/features/chat/Composer.tsx:160` — the `!bash` path routes failures into
  the bash item's own output, which is the better surface.

### 4.1 One `get_messages` + hydrate

`get_messages` is followed by `useChatStore.hydrate(...)` in three places with
three slightly different error postures — `sessions.ts:363`, `rewind.ts:23`,
`ForkPickerModal.tsx:46`. Extract into `src/features/chat/rewind.ts` or
`src/lib/rpc.ts`:

```ts
/** Re-read the transcript from pi and replace the rendered items. */
export async function rehydrateTranscript(sessionId: string): Promise<void>
```

`sessions.ts` additionally calls `ingestFromHistory` for artifacts and has a
`finally { doneResuming }` — keep that at the call site; only the fetch+hydrate
pair moves.

**Verify phase 4:** `npm run test:e2e` is the real gate here (rewind, fork and
clone all have smoke coverage).

---

## Phase 5 — Renderer presentation layer

Highest line-count reduction, lowest individual risk. Purely visual, so e2e +
a manual pass through the app is the check.

> **Landed 2026-08-21** — write-up:
> [log/2026-08-21-presentation-primitives.md](../../log/2026-08-21-presentation-primitives.md).
> 5.1–5.4, 5.6 and 5.7 are done; 5.5 (Composer) shipped separately. Deviations
> from what is written below:
>
> - **5.1** — five sizes (`xs`/`sm`/`md`/`lg`/`xl`), each carrying its own
>   radius. Six one-off paddings folded into a neighbouring step, all moves
>   ≤2px. `TextInput` takes the same treatment with three sizes.
>   `src/features/chat/banners.tsx`, `EditorPane` and `FilesChangedPane` are
>   **not** converted: the last two use `px-2 py-0.5`, denser than any step, and
>   normalizing them would visibly change the pane headers.
> - **5.3** — `ModalPanel` is the panel only, not an overlay wrapper, so the
>   extension dialog host can keep its own portal. Adopted by
>   `RemoveWorktreeModal`, `MergeWorktreeModal` and `ExtensionUiHosts`.
>   `ConfigFileEditor` stays hand-rolled (different background, `h-[70vh]`
>   flex column, header is a path + inline buttons rather than a title), and
>   `FuzzyFinder`/`CommandPalette` stay out as the plan allowed — note they do
>   not use `ModalOverlay` either, which is a separate finding.
> - **5.4** — the hook exposes `setError` rather than `clearError`, because
>   several actions report a non-throwing `{ok: false, reason}` into the same
>   slot, plus an optional `onError` for `BranchPicker`'s `onBusyError`. It
>   lives in `src/components/` (there is no `src/hooks/`). Adopted by
>   `BranchPicker`, `RemoveWorktreeModal` and `MergeWorktreeModal`;
>   `MessageItem`, `ForkPickerModal` and `TreeViewModal` are still open.
> - **5.6** — the generalized `ConfigFileEditor` moves MCP raw-file editing
>   from an inline textarea to the shared Monaco modal. That is a visible
>   change, and the only one in this phase.

### 5.1 Button primitives (`src/components/form.tsx`)

`form.tsx` already exists as the home for shared form primitives but has no
button. Meanwhile:

- primary — `bg-accent hover:bg-accent-hover text-accent-text … rounded-md …
font-medium transition-colors` — **20 occurrences across 14 files**
- secondary — `border-border hover:bg-bg-secondary rounded-md border …
font-medium transition-colors` — **17 occurrences**
- text input — `border-border bg-surface text-text placeholder:text-text-tertiary …` — 6

Add `<Button variant="primary" | "secondary" | "danger" size="sm" | "md">` and
`<TextInput>`. Note the existing strings are _not_ byte-identical — padding
varies (`px-2.5 py-1`, `px-3 py-1`, `px-3.5 py-1.5`). Fold that into a `size`
prop; don't preserve every one-off. `MergeWorktreeModal`/`RemoveWorktreeModal`
also use a `bg-danger` variant.

Files touched: `ConfigFileEditor`, `WebAccessTab`, `BranchPicker`,
`MergeWorktreeModal`, `RemoveWorktreeModal`, `McpTab`, `banners.tsx`,
`CatalogueCards`, `ExtensionsTab`, `ClaudeProviderTab`, `RunCommandRow`,
`PiMissingScreen`, `ExtensionUiHosts`, `GettingStartedScreen`,
`WorkspacePicker`.

### 5.2 Icons into `src/components/icons.tsx`

45 inline `<svg>` literals live outside `icons.tsx`. Duplicated glyphs:

- `d="M3 9h18M9 21h6"` (artifacts) — 3 sites, incl. `Sidebar.tsx` NavRow and
  `TopBar.tsx` `ArtifactsButton` rendering an identical glyph.
- `d="M14.5 2H6a2 2…"` (file) — 3 sites.
- `d="M12 5v14M5 12h14"` (plus) — 3 sites.
- `d="m9 6 6 6-6 6"` (chevron-right) — **`ChevronIcon` in `icons.tsx` already
  renders exactly this**, yet `FileExplorer.tsx` still inlines it. (The other
  inline copy is in `ThinkingBlock.tsx`, deleted in phase 1.) Note
  `Sidebar.tsx`'s local `ChevronDown` is a _different_ path (`m6 9 6 6 6-6`),
  so it needs a new `ChevronDownIcon` rather than reuse.

Move these four plus the single-use bar glyphs (sidebar-toggle, terminal,
changes, usage, resources, gear, pin, arrow-down) into `icons.tsx`, which
already has the `strokeProps(size)` helper to build them on. Biggest wins:
`Sidebar.tsx` (7 inline SVGs, 3 local icon components) and `TopBar.tsx` (5).

### 5.3 Modal panel chrome

`ModalOverlay` handles portal/backdrop/Escape but not the panel. Six surfaces
repeat `border-border bg-surface-raised w-[NNNpx] max-w-[92vw] overflow-hidden
rounded-xl border shadow-2xl` plus a bordered header and a right-aligned footer:
`RemoveWorktreeModal` (440), `MergeWorktreeModal` (460, via a **private
`Shell`** at line 206), `ExtensionUiHosts` (480), `FuzzyFinder` (560),
`CommandPalette` (560), `ConfigFileEditor` (720).

Promote that private `Shell` into `src/components/Modal.tsx` as:

```tsx
<ModalPanel width={440} title="Remove worktree" subtitle={…} footer={…}>
```

`FuzzyFinder` and `CommandPalette` are `align="top"` with no header — they may
only want the width/chrome part. Don't force them in if it costs props.

### 5.4 `useAsyncAction` hook

Six components run the identical machine: `busy` + `error` state, then
`setBusy(true); setError(null); try { … } catch (e) { setError(errorText(e)) }
finally { setBusy(false) }` — `BranchPicker`, `MessageItem`, `TreeViewModal`,
`RemoveWorktreeModal`, `ForkPickerModal`, `MergeWorktreeModal` (twice: `commit`
and `merge`).

```ts
export function useAsyncAction(): {
  busy: boolean
  error: string | null
  clearError: () => void
  run: (fn: () => Promise<void>) => Promise<void>
}
```

`MergeWorktreeModal` needs two actions sharing one `busy`/`error` pair — the
hook returns a `run` that can be called from either, so one instance covers it.

### 5.5 Composer clean-ups (`src/features/chat/Composer.tsx`)

- **`handleKeyDown` lines 274–284 and 291–301 are byte-identical** — the `Enter`
  and `Tab` branches. Merge into one condition.
- **Two parallel overlay state machines.** `mention: MentionState | null` and
  `command: CommandState | null` are mutually exclusive but tracked separately,
  producing `command ? … : mention ? … : …` ternaries in `handleKeyDown`,
  `updateOverlays`, and the render. Replace with one discriminated union:
  ```ts
  type Overlay =
    | { kind: 'command'; query: string; activeIndex: number }
    | { kind: 'mention'; anchor: number; query: string; activeIndex: number }
    | null
  ```
- **`send()` does two unrelated jobs.** Lines 145–188 are a 45-line inline
  `!command` shell path inside the prompt sender. Extract
  `runBashCommand(sessionId, message)` to a sibling module; `send` keeps the
  early `if (message.startsWith('!') && !isStreaming) return runBashCommand(…)`.
- `runCompact` (line 512) is a one-line wrapper around `piCallOk`; inline it.

### 5.6 Cross-feature imports

- `src/features/settings/tabs/McpTab.tsx:17` imports `JobOutput` from its
  sibling `./ExtensionsTab`. Move `JobOutput` to
  `src/features/settings/JobOutput.tsx` (beside `usePackageJob.ts`, which is
  what feeds it) and update both tabs.
- `McpTab.tsx:499 RawFileEditor` is a second implementation of
  `src/features/settings/ConfigFileEditor.tsx` — same textarea, same
  save-or-show-error, different config source. Generalize `ConfigFileEditor` to
  take read/write callbacks (or a scope descriptor) and delete `RawFileEditor`.

### 5.7 Sidebar row indicator

`SessionRow` and `PendingSessionRow` in `Sidebar.tsx` render the same
`data-testid="session-indicator"` span with the same 4-state glyph logic.
Extract `<SessionIndicator state={…} />`. Keep the `data-state` attribute values
exactly as they are — `e2e/smoke.spec.ts` asserts on them.

---

## Phase 6 — Over-exported symbols (optional)

~30 symbols carry `export` but are only referenced inside their own file, which
makes the public surface of each module look larger than it is. Examples:
`PiAgentSettings` and `EditableConfigFile` (`agent-settings.ts`),
`JobSender`/`PiInvoker` (`packages.ts`), `canToggleRightPane`
(`useGlobalShortcuts.ts`), `usePaletteStore` (`CommandPalette.tsx`),
`MCP_SCOPES` (`shared/mcp.ts`).

Two caveats before dropping any `export`:

- Several are **types re-exported through a barrel** (`reducer.ts` re-exports
  from `chatItems.ts` deliberately — "keep one public entry point"). Leave those.
- `shared/rpc.ts`'s `_NoMissingResponseKeys` / `_NoExtraResponseKeys` are the
  compile-time drift guards CLAUDE.md fact #4 describes. **Do not touch them**
  even though nothing imports them.

Low value per edit; do it opportunistically while in a file for another phase
rather than as a sweep.

---

## Sequencing and verification

Land in order — each phase shrinks the surface for the next.

```
1 → dead code + errorText + preload      (no behavior change; e2e for preload)
2 → git layer + json-config              (unit tests cover; one behavior unification)
3 → store slices                         (store tests + e2e session lifecycle)
4 → piCall enforcement                    (e2e: rewind / fork / clone)
5 → presentation                          (e2e + manual pass)
6 → opportunistic
```

After every phase:

```bash
npm run validate
```

and for phases 1, 3, 4, 5:

```bash
npm run test:e2e
```

Per CLAUDE.md, write this up in `docs/log/` when it lands, and update this
plan in place if the work deviates from it.

## Explicitly out of scope

- `src/dev/mockPhosphor.ts` (1021 lines) — a flat channel switch. It reads as
  duplication but each case is an independent fixture; consolidating would
  couple unrelated mocks. Leave it.
- `e2e/smoke.spec.ts` (1135 lines) — repeated locators are the point in tests.
- `shared/rpc.ts` — a deliberate hand-mirror of pi's protocol with compile-time
  drift guards. Do not "simplify" it.
- `electron/pi/session-writer.ts` — documented sharp edge; no cleanup value
  worth the risk.
