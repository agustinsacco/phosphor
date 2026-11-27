import { localServiceId, serviceScope, orderedHostIds } from '@/stores/localServiceScope'
import { brainMachine } from '@/features/brain/brainMachine'
import { useMemo } from 'react'
import { usePlatform } from '@/platform/Platform'
import { localMachineLabel } from '@/lib/localMachine'
import { useLayoutStore } from '@/stores/layout'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'
import { useSettingsUiStore, type SettingsMachine } from './settingsUiStore'

function useActiveRemoteHost(): string | null {
  return useSessionsStore((s) => {
    const target = s.activeSessionId ? s.live[s.activeSessionId]?.target : undefined
    return target?.kind === 'remote' ? target.hostId : null
  })
}

/**
 * The Host Settings opens on: an open machine detail wins, then an explicit
 * This Mac choice in the switcher, even while a Host lane is still active.
 */
export function useSettingsHost(): string | null {
  const remote = useActiveRemoteHost()
  const filter = useRemoteLanesStore((s) => s.filter)
  const page = useLayoutStore((s) => s.page)
  const view = useMachinesStore((s) => s.view)
  if (page === 'machines' && view.kind === 'machine') return view.id
  if (filter === 'local') return null
  return remote ?? (filter !== 'all' ? filter : null)
}

/**
 * The workspace local settings read and write. A Host lane's path names a folder
 * on that Host, so This Mac's settings use This Mac's home workspace instead.
 */
export function useSettingsWorkspace(): string | null {
  const active = useActiveWorkspace()
  const homePath = useWorkspacesStore((s) => s.homePath)
  return useActiveRemoteHost() ? homePath : active
}

export interface SettingsMachineChoice {
  id: SettingsMachine
  label: string
}

/** This Mac when the client has local lanes, then every known Host when it can configure one. */
function useSettingsMachineChoices(brain: boolean): SettingsMachineChoice[] {
  const { localLanes, machineSettings, localBrain, desktopBrainOwner } = usePlatform()
  const machines = useMachinesStore((s) => s.machines)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  return useMemo(() => {
    const local = localServiceId(hosts)
    const label = (id: string): string =>
      id === local ? localMachineLabel() : (machines.find((m) => m.id === id)?.label ?? id)
    const hostIds = orderedHostIds(
      machines.map((m) => m.id),
      hosts,
    )
    const legacy = brain && desktopBrainOwner
    return [
      ...((localLanes && !local) || (legacy && localBrain)
        ? [{ id: 'local', label: localMachineLabel() }]
        : []),
      ...(machineSettings
        ? hostIds.filter((id) => !legacy || id !== local).map((id) => ({ id, label: label(id) }))
        : []),
    ]
  }, [localLanes, machineSettings, machines, hosts, brain, localBrain, desktopBrainOwner])
}

/**
 * The machine the surface configures. The Configure choice wins; otherwise the
 * Settings Host, then This Mac, then the page's machine (`fallback`), then the
 * first Host. Null only when the client can configure no machine.
 */
export function useSettingsMachine(fallback?: string): {
  choices: SettingsMachineChoice[]
  machine: SettingsMachineChoice | null
} {
  const brain = useSettingsUiStore((s) => s.tab === 'brain')
  const choices = useSettingsMachineChoices(brain)
  const { desktopBrainOwner } = usePlatform()
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const chosen = useSettingsUiStore((s) => s.machine)
  const host = useSettingsHost()
  const find = (id: string | null | undefined): SettingsMachineChoice | undefined =>
    id
      ? choices.find(
          (choice) =>
            choice.id ===
            (brain ? brainMachine(id, hosts, desktopBrainOwner) : serviceScope(id, hosts)),
        )
      : undefined
  const machine =
    find(chosen) ??
    (brain ? find(fallback) : undefined) ??
    find(host) ??
    find('local') ??
    find(fallback) ??
    choices[0] ??
    null
  return { choices, machine }
}
