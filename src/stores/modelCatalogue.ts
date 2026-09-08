import { create } from 'zustand'
import type { SubscriptionProviderStatus } from '@shared/models'
import type { ModelCost, ThinkingLevelMap } from '@shared/rpc'

/**
 * The model catalogue every session-less picker reads.
 *
 * Two things were wrong before this store existed. The catalogue was fetched
 * per component, so the home screen re-spawned a pi process every time it
 * mounted; and "we have not asked yet" was indistinguishable from "there are
 * no models", so a picker opened during the fetch showed the definitive "no
 * models configured" copy as if it were the answer.
 *
 * So: one shared fetch, started at boot (`App.tsx`) rather than on first open,
 * and an explicit `status` the pickers can render as loading. Main memoises
 * the underlying spawn as well (`electron/ipc/pi-config-handlers.ts`), so a
 * remount costs an IPC round trip, not a process.
 *
 * One fetch, though, must not mean one CHANCE. Boot is the worst moment to ask
 * — the app is spawning the resumed session's pi at the same time — and when
 * that fetch came back with the models.json fallback, `hydrate()` short-
 * circuited on `status === 'ready'` for the rest of the app's life. `refresh()`
 * existed for exactly this and had no callers anywhere, so the only cure was
 * quitting Phosphor. `hydrate()` now re-asks whenever the list in hand is the
 * degraded one.
 */

export interface CatalogueModel {
  id: string
  name: string
  provider: string
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap | null
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCost
  input?: string[]
}

export type CatalogueStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ModelCatalogueState {
  status: CatalogueStatus
  models: CatalogueModel[]
  /**
   * Where `models` came from. `config` means pi could not be asked and this is
   * only what models.json declares — a few models, not the catalogue.
   */
  source: 'pi' | 'config'
  /** Only meaningful once `status` is 'ready'; used by the empty state. */
  providers: SubscriptionProviderStatus[]
  error: string | null
  /**
   * Fetch, unless a good answer is already in hand. Safe to call from
   * anywhere; concurrent calls share the fetch. A degraded answer is not a
   * good one, so this re-asks pi rather than settling for it forever.
   */
  hydrate: () => Promise<void>
  /** Re-fetch unconditionally, e.g. after a sign-in or a settings change. */
  refresh: () => Promise<void>
  /** Look up a model the same way both pickers do: provider AND id. */
  find: (provider: string | null, id: string | null) => CatalogueModel | undefined
}

/** Shared across concurrent hydrate calls so two pickers cause one fetch. */
let inFlight: Promise<void> | null = null

export const useModelCatalogueStore = create<ModelCatalogueState>((set, get) => ({
  status: 'idle',
  models: [],
  source: 'pi',
  providers: [],
  error: null,

  hydrate: async () => {
    const { status, source } = get()
    if (status === 'loading') {
      await (inFlight ?? Promise.resolve())
      return
    }
    // 'ready' on the models.json fallback is an answer about pi's
    // availability, not about the catalogue. Ask again.
    if (status === 'ready' && source === 'pi') return
    await get().refresh()
  },

  refresh: async () => {
    if (inFlight) return inFlight
    set({ status: 'loading', error: null })
    const run = (async () => {
      try {
        // The auth check is a nice-to-have for the empty state; a failure
        // there must not turn a good model list into an error.
        const [catalogue, providers] = await Promise.all([
          window.phosphor.invoke('pi:catalogueModels'),
          window.phosphor.invoke('pi:subscriptionAuth').catch(() => []),
        ])
        set({
          status: 'ready',
          models: catalogue.models,
          source: catalogue.source,
          providers,
          error: null,
        })
      } catch (error) {
        set({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    inFlight = run
    // Cleared on a microtask, never inside the body: a SYNCHRONOUS throw (a
    // preload that is not wired up yet) runs the whole body before the
    // assignment above lands, so an inline `finally` would clear the slot
    // first and then leave the settled promise parked in it forever — every
    // later refresh would return that same dead promise.
    void run.finally(() => {
      if (inFlight === run) inFlight = null
    })
    return run
  },

  find: (provider, id) =>
    get().models.find((model) => model.id === id && model.provider === provider),
}))

/**
 * How the picker chip should label a configured default.
 *
 * The home picker rendered `current?.name ?? modelId`, and `modelId` comes
 * from a file read that resolves long before the catalogue spawn does — so a
 * new session showed a raw `us.anthropic.claude-...` id for the whole fetch.
 * It also stayed raw forever when the configured provider/model pair was not
 * in the catalogue at all, which looked identical and was a different problem.
 *
 * A third case: the list in hand may be the models.json fallback, in which
 * case "unavailable" is not a claim we can make. `degraded` says so, and the
 * picker explains rather than blaming the user's default.
 */
export function modelChipLabel(
  status: CatalogueStatus,
  model: CatalogueModel | undefined,
  modelId: string | null,
  source: 'pi' | 'config' = 'pi',
): { text: string; loading: boolean; unavailable: boolean; degraded: boolean } {
  if (model) return { text: model.name, loading: false, unavailable: false, degraded: false }
  if (status === 'loading' || status === 'idle') {
    return { text: 'Loading models…', loading: true, unavailable: false, degraded: false }
  }
  if (modelId) {
    // Not in models.json says nothing about pi's catalogue, which is where
    // this model most likely lives.
    const degraded = source === 'config'
    return { text: modelId, loading: false, unavailable: !degraded, degraded }
  }
  return { text: 'Select model', loading: false, unavailable: false, degraded: false }
}

/** Empty-state copy that names what is actually missing. */
export function catalogueEmptyText(
  status: CatalogueStatus,
  providers: SubscriptionProviderStatus[],
): string {
  if (status === 'error') return 'Could not read the model list from pi. Try again.'
  const signedIn = providers.filter((p) => p.status === 'ready')
  if (signedIn.length > 0) {
    return `Signed in to ${signedIn.map((p) => p.name).join(', ')}, but pi reported no models. Check your models.json.`
  }
  return 'No models configured. Sign in to a provider in Settings → Accounts, or add API keys to pi.'
}
