import { machineReadGeneration } from './machineReadGeneration'
import type { SkillsListResult } from '@shared/skills'
import { parseMachineModels, parseMachineProviders } from '@shared/host-protocol-machine'
import { create } from 'zustand'
import type { MachineModel, MachineProvider } from '@shared/host-protocol-machine'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from './remoteLanes'
import { useSkillsStore } from './skills'

let sequence = 0
export const useMachineCataloguesStore = create<{
  hostId: string | null
  models: MachineModel[]
  providers: MachineProvider[]
  error: string | null
  load: (hostId: string | null, workspacePath?: string) => Promise<void>
}>((set) => ({
  hostId: null,
  models: [],
  providers: [],
  error: null,
  async load(hostId, workspacePath) {
    const request = ++sequence
    set({ hostId, models: [], providers: [], error: null })
    if (!hostId) return
    const host = useRemoteLanesStore.getState().hosts[hostId]
    const generation = machineReadGeneration(hostId)
    const current = () => request === sequence && machineReadGeneration(hostId) === generation
    if (host?.state !== 'ready' || !host.capabilities.includes('skills.read')) {
      set({ error: REMOTE_UNAVAILABLE })
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
      set({ models, providers })
    } catch {
      if (current()) set({ error: REMOTE_UNAVAILABLE })
    }
  },
}))
