import { Button } from '@/components/form'
import { useLayoutStore } from '@/stores/layout'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'
import { useSettingsUiStore, type SettingsTab } from './settingsUiStore'

const MACHINE_TABS: readonly SettingsTab[] = [
  'accounts',
  'agent',
  'extensions',
  'claude-provider',
  'connectors',
  'web-access',
  'computer-use',
  'subagents',
  'optimization',
  'advanced',
  'workspaces',
  'voice',
]

function useActiveRemoteHost(): string | null {
  return useSessionsStore((s) => {
    const target = s.activeSessionId ? s.live[s.activeSessionId]?.target : undefined
    return target?.kind === 'remote' ? target.hostId : null
  })
}

/**
 * The machine Settings describes. An open machine detail wins, then an explicit
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

export function isMachineSettingsTab(tab: SettingsTab): boolean {
  return MACHINE_TABS.includes(tab)
}

/** Keep local machine effects unmounted while viewing a Host. */
export function SettingsMachineScope({ hostId }: { hostId: string | null }): React.JSX.Element {
  const label =
    useMachinesStore((s) => s.machines.find((m) => m.id === hostId)?.label) ?? 'this machine'
  const supported = useRemoteLanesStore(
    (s) => !!hostId && s.hosts[hostId]?.configurationSupported === true,
  )
  return (
    <div className="border-border bg-bg-secondary text-text mb-5 rounded-lg border p-3 text-base">
      <p className="text-text font-medium">This Mac</p>
      <p className="text-text-secondary mt-1">
        These settings configure This Mac, not a remote machine.
      </p>
      {hostId && (
        <>
          <p className="text-text-secondary mt-2">
            {supported ? 'To configure' : 'To sign in on'} {label}, use Machines → {label} →{' '}
            {supported ? 'Settings' : 'Readiness'}.
          </p>
          <p className="text-text-secondary mt-1">Remote settings are not available here.</p>
          <Button
            className="mt-3"
            onClick={() => {
              useSettingsUiStore.getState().setOpen(false)
              useMachinesStore
                .getState()
                .show(
                  supported
                    ? { kind: 'machine', id: hostId, settings: 'providers' }
                    : { kind: 'machine', id: hostId },
                )
            }}
          >
            Open {label} {supported ? 'settings' : 'readiness'}
          </Button>
        </>
      )}
    </div>
  )
}
