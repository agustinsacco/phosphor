import { SettingsNotice, type SettingsNoticeAction } from '@/components/form'
import { Spinner } from '@/components/icons'
import { WaitingNote } from '@/components/Waiting'
import { CopyCommand } from '@/features/machines/MachineControls'
import { useMachinesStore } from '@/stores/machines'
import { errorText } from '@shared/errors'
import { useSettingsUiStore } from '../settingsUiStore'
import { useHostSection, type HostSection } from './HostSection'
import { hostSettingsStatus, type HostGateAction, type HostGateNotice } from './hostSettingsStatus'

/**
 * A Host section's view, once the Host is reachable, new enough, this client
 * holds the configuration grant and the settings have loaded; a section that
 * reads only the link (`connection`) needs the link alone. Until then, the one
 * notice that says why, with the one action that helps.
 */
export function HostGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const host = useHostSection()
  const { machine, settings, connection, allowed, reads, error, terminalLink, starting } = host
  const record = useMachinesStore((s) => s.machines.find((m) => m.id === machine.id))
  // Signed out the store holds no clock reading (0); a selector reading the clock would never settle.
  const nowMs = useMachinesStore((s) => s.nowMs)
  const clockOffsetMs = useMachinesStore((s) => s.clockOffsetMs)
  const now = (nowMs || Date.now()) + clockOffsetMs
  const status = hostSettingsStatus({
    label: machine.label,
    machine: record,
    connection,
    allowed,
    reads,
    read: { loading: settings.loading, error: settings.error, loaded: settings.data !== null },
    now,
  })
  // A failed read is the notice itself; any other error (a save, a program, the grant) sits above.
  const problem =
    error ?? (status.kind === 'notice' && status.action === 'retry' ? null : settings.error)
  return (
    <div className="min-w-0 space-y-4">
      {problem && <SettingsNotice tone="danger" title={problem} />}
      {status.kind === 'notice' ? (
        <GateNotice notice={status} host={host} />
      ) : status.kind === 'loading' ? (
        <WaitingNote className="py-4">Loading machine settings…</WaitingNote>
      ) : (
        <>
          {!terminalLink && (
            <SettingsNotice
              tone="warning"
              title="Native Host terminal support is unavailable or not granted."
              body="Sign-in and setup actions are disabled; read-only checks remain available."
            />
          )}
          {starting && (
            <p role="status" className="text-text-secondary flex items-center gap-2 text-base">
              <Spinner />
              Starting the private program on {machine.label}…
            </p>
          )}
          {children}
        </>
      )}
    </div>
  )
}

function GateNotice({
  notice,
  host,
}: {
  notice: HostGateNotice
  host: HostSection
}): React.JSX.Element {
  return (
    <SettingsNotice
      tone={notice.tone}
      title={notice.title}
      body={
        <>
          <p>{notice.detail}</p>
          {notice.command && <CopyCommand command={notice.command} />}
          {notice.lastError && (
            <p className="text-text-tertiary text-sm">
              Last error: <code className="font-mono">{notice.lastError}</code>
            </p>
          )}
        </>
      }
      action={notice.action && gateAction(notice.action, host)}
    />
  )
}

function gateAction(action: HostGateAction, host: HostSection): SettingsNoticeAction {
  const { machine, settings, accessBusy, access, setError } = host
  switch (action) {
    case 'reconnect':
      return {
        label: 'Reconnect',
        disabled: accessBusy,
        onClick: () =>
          void window.phosphor
            .invoke('hosts:reconnect', machine.id)
            .catch((e) => setError(errorText(e))),
      }
    case 'enable-access':
      return {
        label: 'Enable configuration access',
        busyLabel: 'Enabling access…',
        busy: accessBusy,
        onClick: () => void access(),
      }
    case 'retry':
      return { label: 'Retry', busy: settings.loading, onClick: () => void settings.refresh() }
    case 'account':
      return {
        label: 'Open Phosphor account',
        onClick: () => useSettingsUiStore.getState().setTab('account'),
      }
  }
}
