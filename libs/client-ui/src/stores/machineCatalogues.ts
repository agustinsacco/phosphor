import { useEffect } from 'react'
import { machineReadGeneration } from './machineReadGeneration'
import { parseMachineModelList, parseMachineProviders } from '@shared/host-protocol-machine'
import { create } from 'zustand'
import type {
  MachineModel,
  MachineModelDefaults,
  MachineProvider,
} from '@shared/host-protocol-machine'
import { hostFeatureRefusal } from './hostRefusals'
import { useRemoteLanesStore } from './remoteLanes'

/** A Host model read that failed or replied with something unreadable, in every reader's words. */
export const MODELS_READ_FAILED = 'Could not read models.'

export interface MachineCatalogue {
  models: MachineModel[]
  /** The Host pi's own new-session defaults, when it sets them; an older Host has none. */
  defaults?: MachineModelDefaults
  source?: 'config'
  failures?: number
  refreshing?: boolean
  checkedAt?: number
  providers: MachineProvider[]
  error: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
}
export const EMPTY_MACHINE_CATALOGUE: MachineCatalogue = Object.freeze({
  models: [],
  providers: [],
  error: null,
  status: 'idle',
})
export function machineCatalogueKey(
  hostId: string,
  generation = machineReadGeneration(hostId),
): string {
  return `${hostId}:${generation}`
}

export const useMachineCataloguesStore = create<{
  catalogues: Record<string, MachineCatalogue>
  load: (hostId: string | null, mode?: 'retry' | 'recheck') => Promise<void>
  adoptDefaults: (hostId: string, defaults: MachineModelDefaults | undefined) => void
}>((set, get) => ({
  catalogues: {},
  /**
   * After this client saved the Host pi's machine-wide defaults: a ready
   * catalogue takes them as the next read would answer, and one still loading
   * reads again, as its answer may predate the save.
   */
  adoptDefaults(hostId, defaults) {
    const key = machineCatalogueKey(hostId)
    const entry = get().catalogues[key]
    if (entry?.status === 'loading' || entry?.refreshing) return void get().load(hostId, 'retry')
    if (entry?.status !== 'ready') return
    const next: MachineCatalogue = { ...entry }
    if (defaults) next.defaults = defaults
    else delete next.defaults
    set((s) => ({ catalogues: { ...s.catalogues, [key]: next } }))
  },
  async load(hostId, mode) {
    // A consumer leaving a page does not own another consumer's catalogue.
    if (!hostId) return
    const generation = machineReadGeneration(hostId)
    const key = machineCatalogueKey(hostId, generation)
    const existing = get().catalogues[key]
    if (!mode && (existing?.status === 'loading' || existing?.status === 'ready')) return
    const previous = existing?.status === 'ready' && mode === 'recheck' ? existing : null
    const entry: MachineCatalogue = {
      ...(previous ?? EMPTY_MACHINE_CATALOGUE),
      status: previous ? 'ready' : 'loading',
      refreshing: true,
      checkedAt: Date.now(),
    }
    set((s) => ({ catalogues: { ...s.catalogues, [key]: entry } }))
    const current = () =>
      get().catalogues[key] === entry && machineReadGeneration(hostId) === generation
    const finish = (patch: Partial<MachineCatalogue>) => {
      if (current())
        set((s) => ({
          catalogues: { ...s.catalogues, [key]: { ...entry, ...patch, refreshing: false } },
        }))
    }
    const host = useRemoteLanesStore.getState().hosts[hostId]
    const refusal = hostFeatureRefusal(host, 'skills.read', 'models')
    if (refusal) {
      finish({ error: refusal, status: 'error' })
      return
    }
    try {
      const list =
        previous && !previous.source
          ? previous
          : parseMachineModelList(await window.phosphor.invoke('hosts:models', hostId))
      if (!current()) return
      const providers = parseMachineProviders(
        await window.phosphor.invoke('hosts:providers', hostId),
      )
      if (!current()) return
      if (!list || !providers) throw new Error(MODELS_READ_FAILED)
      finish({
        ...list,
        source: list.source,
        defaults: list.defaults,
        error: null,
        providers,
        checkedAt: Date.now(),
        failures: 0,
        status: 'ready',
      })
    } catch {
      finish({
        error: MODELS_READ_FAILED,
        failures: (existing?.failures ?? 0) + 1,
        status: 'error',
      })
    }
  },
}))

/** A completed private program can change auth even if its settings page is left next. */
export function recheckMachineCatalogue(hostId: string): void {
  const state = useMachineCataloguesStore.getState()
  if (state.catalogues[machineCatalogueKey(hostId)]) void state.load(hostId, 'recheck')
}

/** A Host's catalogue for its current connection, loaded while `active`; empty for none. */
export function useMachineCatalogue(hostId: string | null, active = true): MachineCatalogue {
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const catalogue = useMachineCataloguesStore((s) =>
    hostId ? s.catalogues[machineCatalogueKey(hostId, generation)] : undefined,
  )
  useEffect(() => {
    if (hostId && active) void useMachineCataloguesStore.getState().load(hostId)
  }, [hostId, active, generation])
  useEffect(() => {
    if (!hostId || !active) return
    const focus = () => {
      const entry = useMachineCataloguesStore.getState().catalogues[machineCatalogueKey(hostId)]
      if (entry && !entry.refreshing && Date.now() - (entry.checkedAt ?? 0) >= 15_000)
        recheckMachineCatalogue(hostId)
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [active, hostId])
  useEffect(() => {
    if (
      !active ||
      !hostId ||
      catalogue?.refreshing ||
      (!catalogue?.failures && catalogue?.source !== 'config')
    )
      return
    const key = machineCatalogueKey(hostId, generation)
    const delay = Math.min(
      60_000,
      5000 * 2 ** Math.min(4, Math.max(0, (catalogue.failures ?? 1) - 1)),
    )
    const timer = setTimeout(() => {
      if (useMachineCataloguesStore.getState().catalogues[key] === catalogue)
        recheckMachineCatalogue(hostId)
    }, delay)
    return () => clearTimeout(timer)
  }, [catalogue, hostId, generation, active])
  return catalogue ?? EMPTY_MACHINE_CATALOGUE
}
