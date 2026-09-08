# 2026-08-28 — Unsent drafts now survive a session switch and a restart

Typing a prompt, pasting a screenshot into it, and then opening another
session lost all of it, silently. Quitting did the same.

Both composers kept `text` and `images` in local `useState`, and `App` renders
`<ChatView key={activeSessionId}>` — switching session unmounts the whole
subtree. The only rescue path that existed was `startingChat`'s `ComposerDraft`,
in memory, and only for a session that **failed** to start.

## One store, two keys

`src/stores/drafts.ts` holds text, pending attachments, and the model the
draft was composed against.

- `session:<sessionFilePath>` for a live chat, falling back to
  `session:<PhosphorId>` before pi reports the path. The file path is the only
  identity that survives a restart; `rekey` moves the draft across when the
  path arrives, so a draft typed in a session's first moments is not stranded.
- `home:<workspacePath>` for the not-yet-created chat.

Lifting the value out of the component is what makes a session switch
survivable, and it is the same mechanism that makes a restart survivable — so
`key={activeSessionId}` stays, and keeps per-session transcript state honest.

`startingChat`'s duplicate draft type is retired; a failed start now re-fills
the same store.

## Image bytes are files, not prefs

A pasted screenshot is megabytes of base64. Putting that in electron-store
means re-serialising `config.json` on every debounced keystroke. So the prefs
record holds a `blobId` and the bytes live one file each under
`userData/drafts/` (`electron/drafts-blobs.ts`) — the first binary this repo
writes under userData.

**The directory is resolved lazily**, exactly like `electron/store.ts`'s
electron-store, and for the same reason: `app.getPath('userData')` at module
scope runs before `main.ts` can redirect userData for E2E, and a test's pasted
images would land in the developer's real profile.

The blob id is carried **on the in-memory attachment**, not in a module-level
map keyed by object identity. The same image can sit in two drafts, and
sharing one blob between them means clearing either draft unlinks the other's
bytes.

## Bookkeeping

- Writes are debounced 400 ms per key; `clear` cancels a pending write, or a
  send would be followed by the draft it just cleared coming back.
- A draft that goes empty is deleted rather than stored blank.
- `pruneDrafts` keeps the newest 30 and **returns the blob ids it dropped**, so
  the files go with the records. `MAX_DRAFT_BLOB_BYTES` caps the directory at
  50 MB; a refused write is reported to the user rather than silently dropped.
- `app:sweepDrafts` at launch drops drafts whose workspace is gone and unlinks
  every blob no surviving draft refers to.
- `sessions:delete` clears that session's draft and blobs. Note that it still
  reclaims nothing else keyed on a session path — `seenSessions` and
  `pinnedSessions` continue to rely on their own prune plus the launch-time
  existence check.

## What is not persisted

The workspace and isolation toggle are recorded on the draft, but the model
selection still also writes pi's global `defaultProvider`/`defaultModel`, as
before. The draft's own model is an **override**: coming back to a draft
restores the model you chose for it rather than whatever a later session set
globally.

The browser harness (`src/dev/mockPhosphor.ts`) answers the draft channels
in-memory only. There is no main process there to persist to, and a fake blob
store would only hide that.

Tests: `src/stores/drafts.test.ts`, `electron/drafts-blobs.test.ts`,
`electron/prefs-utils.test.ts` (prune / sweep / orphans), and an e2e that types
a draft, pastes an image, navigates away, relaunches, and finds both back.
