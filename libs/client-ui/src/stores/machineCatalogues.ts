import { useEffect } from 'react'
import { machineReadGeneration } from './machineReadGeneration'
import type { SkillsListResult } from '@shared/skills'
import { parseMachineModels, parseMachineProviders } from '@shared/host-protocol-machine'
import { create } from 'zustand'
import type { MachineModel, MachineProvider } from '@shared/host-protocol-machine'
import { hostFeatureRefusal } from './hostRefusals'
import { useRemoteLanesStore } from './remoteLanes'
import { useSkillsStore } from './skills'

/** A Host model read that failed or replied with something unreadable, in every reader's words. */
export const MODELS_READ_FAILED = 'Could not read models.'

/**
 * How long a Host's models and sign-ins count as current. A picker that opens
 * on an older read reads them again (`revalidate`). Each read spawns pi and
 * checks the Claude sign-in on the Host, so this is not zero, and nothing polls.
 */
export const MACHINE_CATALOGUE_FRESH_MS = 30_000

export interface MachineCatalogue {
  models: MachineModel[]
  providers: MachineProvider[]
  error: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** `Date.now()` when `models` and `providers` were read. */
  readAt?: number
  /** A re-read is running. `models` stay listed until it answers. */
  refreshing?: boolean
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

/** Models, then sign-ins. The Host serializes its machine probe. Do not issue parallel reads. */
async function readModels(
  hostId: string,
  current: () => boolean,
): Promise<Pick<MachineCatalogue, 'models' | 'providers'> | null> {
  const models = parseMachineModels(await window.phosphor.invoke('hosts:models', hostId))
  if (!current()) return null
  const providers = parseMachineProviders(await window.phosphor.invoke('hosts:providers', hostId))
  if (!current()) return null
  if (!models || !providers) throw new Error(MODELS_READ_FAILED)
  return { models, providers }
}

export const useMachineCataloguesStore = create<{
  catalogues: Record<string, MachineCatalogue>
  load: (hostId: string | null, workspacePath?: string, force?: boolean) => Promise<void>
  /**
   * Read a ready catalogue again when it is older than `maxAgeMs`, keeping its
   * models listed meanwhile; a failed re-read keeps them too. `0` is for after
   * a change Phosphor made on the Host (a sign-in, an install). A failed first
   * read is retried; one never started is `load`'s.
   */
  revalidate: (hostId: string | null, maxAgeMs?: number) => Promise<void>
}>((set, get) => ({
  catalogues: {},
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
      let skills: SkillsListResult | undefined
      if (workspacePath && !workspacePath.endsWith('/machine'))
        await useSkillsStore.getState().refresh(workspacePath)
      else skills = await window.phosphor.invoke('hosts:skills', hostId)
      if (!current()) return
      if (skills)
        useSkillsStore.setState((s) => ({
          byWorkspace: { ...s.byWorkspace, [`host:${hostId}/machine`]: skills },
        }))
      const read = await readModels(hostId, current)
      if (read) finish({ ...read, status: 'ready', readAt: Date.now() })
    } catch {
      if (current()) finish({ error: MODELS_READ_FAILED, status: 'error' })
    }
  },
  async revalidate(hostId, maxAgeMs = MACHINE_CATALOGUE_FRESH_MS) {
    if (!hostId) return
    const generation = machineReadGeneration(hostId)
    const key = machineCatalogueKey(hostId, generation)
    const existing = get().catalogues[key]
    if (existing?.status === 'error') return get().load(hostId)
    if (existing?.status !== 'ready' || existing.refreshing) return
    if (Date.now() - (existing.readAt ?? 0) < maxAgeMs) return
    const host = useRemoteLanesStore.getState().hosts[hostId]
    if (hostFeatureRefusal(host, 'skills.read', 'models')) return
    const entry: MachineCatalogue = { ...existing, refreshing: true }
    set((s) => ({ catalogues: { ...s.catalogues, [key]: entry } }))
    const current = () =>
      get().catalogues[key] === entry && machineReadGeneration(hostId) === generation
    const settle = (next: MachineCatalogue) => {
      if (current()) set((s) => ({ catalogues: { ...s.catalogues, [key]: next } }))
    }
    try {
      const read = await readModels(hostId, current)
      if (read) settle({ ...read, error: null, status: 'ready', readAt: Date.now() })
    } catch {
      settle(existing)
    }
  },
}))

/**
 * A Host's catalogue for its current connection, loaded while `active`, and read
 * again when it becomes active on an old read; empty for none.
 */
export function useMachineCatalogue(hostId: string | null, active = true): MachineCatalogue {
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const catalogue = useMachineCataloguesStore((s) =>
    hostId ? s.catalogues[machineCatalogueKey(hostId, generation)] : undefined,
  )
  useEffect(() => {
    if (!hostId || !active) return
    const store = useMachineCataloguesStore.getState()
    void store.load(hostId)
    void store.revalidate(hostId)
  }, [hostId, active, generation])
  return catalogue ?? EMPTY_MACHINE_CATALOGUE
}
