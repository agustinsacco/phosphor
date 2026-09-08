# The model catalogue's fallback was silent, and permanent

A new session's model picker showed one model — `Qwen 3.8 125b · local-stark`,
"1 of 1" — and reported the configured default, `pi-claude-cli / claude-opus-5`,
as **unavailable**. pi itself was healthy the whole time: the same
`get_available_models` call returns 530 models in 1.4–3.4s from a shell, from
vitest, from an unpackaged Electron main process, and from one launched with the
packaged app's cwd (`/`) and its stripped launchd `PATH`. So the boot-time fetch
failed transiently. Two things then turned that into a permanent, invisible
wrong answer.

**It never retried.** `useModelCatalogueStore.hydrate()` short-circuited on
`status === 'ready'`, and `refresh()` — written for exactly this — had no callers
anywhere in the app. One bad answer at boot lasted until Phosphor was quit. Boot is
also the worst moment to ask: the app spawns the resumed session's pi about 30ms
before the throwaway catalogue pi, so two cold pi boots race each other.

**It never said so.** `resolveCatalogueModels` swallowed every failure into a
bare `catch {}` and returned models.json as though it were the catalogue. Nothing
reached `phosphor.log`, and the store reported `status: 'ready'`. The picker then
blamed the user's default — models.json not listing `claude-opus-5` says nothing
about pi's catalogue, which is where that provider actually lives.

## What changed

- `resolveCatalogueModels` returns `{ models, source: 'pi' | 'config' }` and logs
  the fallback reason to `phosphor.log` under `[models]`.
- `createTtlCache` accepts a per-value TTL. Main holds pi's own answer for
  5 minutes and a models.json fallback for 20 seconds, so the next ask retries pi
  instead of remembering a stand-in.
- `hydrate()` re-asks while `source === 'config'`; opening the home picker also
  triggers a refresh. Both are cheap — main serves a good answer from cache.
- The chip reads `· pi unreachable` rather than `· unavailable`, and the open
  menu carries a one-line notice above a list it knows is incomplete.

## Also

`npm run dev` exited with no window and no message whenever the installed Phosphor
held the single-instance lock — electron-vite prints `starting electron app...`
and then nothing. `electron/main.ts` now says so on the way out, and names the
`PHOSPHOR_TEST_USER_DATA` workaround. That silence is why this class of bug is hard
to reproduce locally.
