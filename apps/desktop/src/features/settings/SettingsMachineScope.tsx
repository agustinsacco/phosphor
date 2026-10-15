import { Button } from '@/components/form'
import { useLayoutStore } from '@/stores/layout'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
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

export function useSettingsHost(): string | null {
  const target = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId]?.target : undefined,
  )
  const filter = useRemoteLanesStore((s) => s.filter)
  const page = useLayoutStore((s) => s.page)
  const view = useMachinesStore((s) => s.view)
  if (page === 'machines' && view.kind === 'machine') return view.id
  return target?.kind === 'remote'
    ? target.hostId
    : filter !== 'local' && filter !== 'all'
      ? filter
      : null
}

export function isMachineSettingsTab(tab: SettingsTab): boolean {
  return MACHINE_TABS.includes(tab)
}

/** Keep local machine effects unmounted while viewing a Host. */
export function SettingsMachineScope({ hostId }: { hostId: string | null }): React.JSX.Element {
  const label =
    useMachinesStore((s) => s.machines.find((m) => m.id === hostId)?.label) ?? 'this machine'
  return (
    <div className="border-border bg-bg-secondary text-text mb-5 rounded-lg border p-3 text-base">
      <p className="text-text font-medium">This Mac</p>
      <p className="text-text-secondary mt-1">
        These settings configure This Mac, not a remote machine.
      </p>
      {hostId && (
        <>
          <p className="text-text-secondary mt-2">
            To sign in on {label}, use Machines → {label} → Readiness.
          </p>
          <p className="text-text-secondary mt-1">Remote settings are not available here.</p>
          <Button
            className="mt-3"
            onClick={() => {
              useSettingsUiStore.getState().setOpen(false)
              useMachinesStore.getState().show({ kind: 'machine', id: hostId })
            }}
          >
            Open {label} readiness
          </Button>
        </>
      )}
    </div>
  )
}
