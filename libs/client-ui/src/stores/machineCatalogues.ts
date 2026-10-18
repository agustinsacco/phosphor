import { machineReadGeneration } from './machineReadGeneration'
import type { SkillsListResult } from '@shared/skills'
import { parseMachineModels, parseMachineProviders } from '@shared/host-protocol-machine'
import { create } from 'zustand'
import type { MachineModel, MachineProvider } from '@shared/host-protocol-machine'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from './remoteLanes'
import { useSkillsStore } from './skills'

export interface MachineCatalogue {
  models: MachineModel[]
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
    if (host?.state !== 'ready' || !host.capabilities.includes('skills.read')) {
      finish({ error: REMOTE_UNAVAILABLE, status: 'error' })
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
      const models = parseMachineModels(await window.phosphor.invoke('hosts:models', hostId))
      if (!current()) return
      const providers = parseMachineProviders(
        await window.phosphor.invoke('hosts:providers', hostId),
      )
      if (!current()) return
      if (!models || !providers) throw new Error(REMOTE_UNAVAILABLE)
      finish({ models, providers, status: 'ready' })
    } catch {
      if (current()) finish({ error: REMOTE_UNAVAILABLE, status: 'error' })
    }
  },
}))
