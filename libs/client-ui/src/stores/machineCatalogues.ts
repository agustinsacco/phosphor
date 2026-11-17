import { useEffect } from 'react'
import { machineReadGeneration } from './machineReadGeneration'
import type { SkillsListResult } from '@shared/skills'
import { parseMachineModelList, parseMachineProviders } from '@shared/host-protocol-machine'
import { create } from 'zustand'
import type {
  MachineModel,
  MachineModelDefaults,
  MachineProvider,
} from '@shared/host-protocol-machine'
import { hostFeatureRefusal } from './hostRefusals'
import { useRemoteLanesStore } from './remoteLanes'
import { useSkillsStore } from './skills'

/** A Host model read that failed or replied with something unreadable, in every reader's words. */
export const MODELS_READ_FAILED = 'Could not read models.'

export interface MachineCatalogue {
  models: MachineModel[]
  /** The Host pi's own new-session defaults, when it sets them; an older Host has none. */
  defaults?: MachineModelDefaults
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
  load: (hostId: string | null, workspacePath?: string, force?: boolean) => Promise<void>
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
    if (entry?.status === 'loading') return void get().load(hostId, undefined, true)
    if (entry?.status !== 'ready') return
    const next: MachineCatalogue = { ...entry }
    if (defaults) next.defaults = defaults
    else delete next.defaults
    set((s) => ({ catalogues: { ...s.catalogues, [key]: next } }))
  },
  async load(hostId, workspacePath, force = false) {
    // A consumer leaving a page does not own another consumer's catalogue.
    if (!hostId) return
    const generation = machineReadGeneration(hostId)
    const key = machineCatalogueKey(hostId, generation)
    const existing = get().catalogues[key]
    if (!force && (existing?.status === 'loading' || existing?.status === 'ready')) return
    const entry: MachineCatalogue = { ...EMPTY_MACHINE_CATALOGUE, status: 'loading' }
    set((s) => ({ catalogues: { ...s.catalogues, [key]: entry } }))
    const current = () =>
      get().catalogues[key] === entry && machineReadGeneration(hostId) === generation
    const finish = (patch: Partial<MachineCatalogue>) => {
      if (current())
        set((s) => ({ catalogues: { ...s.catalogues, [key]: { ...entry, ...patch } } }))
    }
    const host = useRemoteLanesStore.getState().hosts[hostId]
    const refusal = hostFeatureRefusal(host, 'skills.read', 'models')
    if (refusal) {
      finish({ error: refusal, status: 'error' })
      return
    }
    try {
      // The Host serializes its machine probe. Do not issue parallel catalogue reads.
      let skills: SkillsListResult | undefined
      if (workspacePath && !workspacePath.endsWith('/machine'))
        await useSkillsStore.getState().refresh(workspacePath)
      else skills = await window.phosphor.invoke('hosts:skills', hostId)
      if (!current()) return
      if (skills)
        useSkillsStore.setState((s) => ({
          byWorkspace: { ...s.byWorkspace, [`host:${hostId}/machine`]: skills },
        }))
      const list = parseMachineModelList(await window.phosphor.invoke('hosts:models', hostId))
      if (!current()) return
      const providers = parseMachineProviders(
        await window.phosphor.invoke('hosts:providers', hostId),
      )
      if (!current()) return
      if (!list || !providers) throw new Error(MODELS_READ_FAILED)
      finish({ ...list, providers, status: 'ready' })
    } catch {
      if (current()) finish({ error: MODELS_READ_FAILED, status: 'error' })
    }
  },
}))

/** A Host's catalogue for its current connection, loaded while `active`; empty for none. */
export function useMachineCatalogue(hostId: string | null, active = true): MachineCatalogue {
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const catalogue = useMachineCataloguesStore((s) =>
    hostId ? s.catalogues[machineCatalogueKey(hostId, generation)] : undefined,
  )
  useEffect(() => {
    if (hostId && active) void useMachineCataloguesStore.getState().load(hostId)
  }, [hostId, active, generation])
  return catalogue ?? EMPTY_MACHINE_CATALOGUE
}
