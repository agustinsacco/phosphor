import { useMemo } from 'react'
import { usePlatform } from '@/platform/Platform'
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
function useSettingsMachineChoices(): SettingsMachineChoice[] {
  const { localLanes, machineSettings } = usePlatform()
  const machines = useMachinesStore((s) => s.machines)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  return useMemo(() => {
    const label = (id: string): string => machines.find((m) => m.id === id)?.label ?? id
    const hostIds = [...new Set([...machines.map((m) => m.id), ...Object.keys(hosts)])]
    return [
      ...(localLanes ? [{ id: 'local', label: 'This Mac' }] : []),
      ...(machineSettings ? hostIds.map((id) => ({ id, label: label(id) })) : []),
    ]
  }, [localLanes, machineSettings, machines, hosts])
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
  const choices = useSettingsMachineChoices()
  const chosen = useSettingsUiStore((s) => s.machine)
  const host = useSettingsHost()
  const find = (id: string | null | undefined): SettingsMachineChoice | undefined =>
    id ? choices.find((choice) => choice.id === id) : undefined
  const machine =
    find(chosen) ?? find(host) ?? find('local') ?? find(fallback) ?? choices[0] ?? null
  return { choices, machine }
}

/** The one line that says which machine a machine section configures. */
export function SettingsMachineScope({
  machine,
}: {
  machine: SettingsMachineChoice
}): React.JSX.Element {
  return (
    <p
      className="border-border bg-bg-secondary text-text mb-5 rounded-lg border px-3 py-2 text-base font-medium"
      data-testid="settings-machine-scope"
    >
      Configuring {machine.label}
      <span className="text-text-secondary font-normal">
        {machine.id === 'local'
          ? '. These settings stay on This Mac.'
          : '. Credentials stay on this Host; nothing syncs to another machine.'}
      </span>
    </p>
  )
}
