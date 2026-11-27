import { useState, type ReactNode } from 'react'
import type {
  LocalMachineAction,
  LocalMachineStatus,
  LocalServiceInstall,
} from '@phosphor/shared/ipc'
import { Button, SectionTitle } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { useOpAction } from '@/features/agent-control/useOpRead'
import { holdUpdatePage } from '@/features/updates/machineUpdateState'
import { useMachineUpdatesStore } from '@/stores/machineUpdates'
import { useLocalServiceStatus } from '@/features/updates/useLocalServiceStatus'
import { usePlatform } from '@/platform/Platform'
import { localServiceId } from '@/stores/localServiceScope'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

type Click = (action: LocalMachineAction, label: string) => ReactNode
const notice = {
  'no-bundle': 'A Phosphor service release is not yet available for this computer.',
  'other-daemon':
    'Another Phosphor service already runs lanes on this Mac. Stop or uninstall it, then restart Phosphor.',
  limits: 'This Mac’s lanes exceed what the service can move safely.',
  'state-folder': 'The service’s state folder must be private and owned by this user.',
  'dev-build': 'This data belongs to the Phosphor service. Run dev with PHOSPHOR_TEST_USER_DATA.',
}

/** The background install while in-app: what it is doing, or why it cannot finish. */
function installLine(install: LocalServiceInstall | undefined): string | null {
  const version = install?.version ? ` ${install.version}` : ''
  switch (install?.state) {
    case 'checking':
      return 'Checking for the Phosphor service…'
    case 'installing':
      return install.step === 'setup'
        ? `Setting up the Phosphor service${version}…`
        : `Downloading the Phosphor service${version}…`
    case 'installed':
      return `Phosphor service${version} is installed. This Mac moves its lanes to it the next time Phosphor starts.`
    case 'failed':
      return `Couldn’t set up the Phosphor service: ${(install.detail ?? 'unknown error').replace(/\.$/, '')}. Phosphor tries again later.`
    case 'waiting':
    case 'blocked':
      return install.detail ?? null
    default:
      return null
  }
}

function migrationRow(status: LocalMachineStatus, button: Click) {
  if (status.mode === 'in-app' && status.migration === 'committed')
    return (
      <>
        <p>Restart to finish setting up this Mac</p>
        {button('restart-to-finish', 'Restart Phosphor')}
      </>
    )
  switch (status.migration) {
    case 'failed':
      return (
        <>
          <p>Couldn’t finish setting up the Phosphor service.</p>
          {status.failure && (
            <details>
              <TooltipSummary>Setup details</TooltipSummary>
              {status.failure.step}: {status.failure.code}
            </details>
          )}
          {button('retry-migration', 'Retry')}
          {button('export-diagnostics', 'Export diagnostics')}
        </>
      )
    case 'consent-needed':
      return (
        <>
          <p>{notice['other-daemon']}</p>
          {button('consent-migration', 'Continue setup')}
        </>
      )
    case 'reverted':
      return (
        <>
          <p>Service setup was reverted.</p>
          {button('retry-migration', 'Retry')}
        </>
      )
    case 'repairing':
    case 'running':
      return <p>Setting up the Phosphor service: {status.step}</p>
    default:
      return status.notice ? (
        <p>{notice[status.notice]}</p>
      ) : status.mode === 'in-app' ? (
        <>
          <p>This Mac runs its lanes in Desktop.</p>
          {installLine(status.install) && <p role="status">{installLine(status.install)}</p>}
        </>
      ) : null
  }
}

function OwnerKeyRow({
  access,
  button,
}: {
  access: NonNullable<LocalMachineStatus['ownerKeyAccess']>
  button: Click
}) {
  return (
    <>
      <p role="status">
        Phosphor uses your system’s protected storage to open the key for its local service.
        {access === 'checking'
          ? ' If your system asks for approval, respond in its own dialog, not in Phosphor.'
          : ' Phosphor couldn’t open the key. Check that your Keychain or keyring is available, then retry.'}
      </p>
      {access === 'unavailable' && button('retry-owner-key', 'Retry key access')}
    </>
  )
}

function ServiceCard({ machine, children }: { machine: string; children?: ReactNode }) {
  const { status, error, reload } = useLocalServiceStatus()
  const updating = useMachineUpdatesStore(
    (s) =>
      holdUpdatePage(s.byMachine[machine]?.run) || s.byMachine[machine]?.run?.finish === 'not-back',
  )
  const action = useOpAction()
  const [message, setMessage] = useState<string>()
  function retryService() {
    action.run(async () => {
      const id = localServiceId(useRemoteLanesStore.getState().hosts)
      if (id) await window.phosphor.invoke('hosts:reconnect', id)
      reload()
    })
  }
  const button: Click = (name, label) => (
    <Button
      disabled={action.busy}
      onClick={() =>
        action.run(async () => {
          setMessage('')
          const result = await window.phosphor.invoke('app:localMachineAction', name)
          setMessage(result.message ?? (result.ok ? '' : 'The service refused the action.'))
          reload()
        })
      }
    >
      {label}
    </Button>
  )
  const recovery = status?.mode === 'daemon' && status.service !== 'ready'
  const migration = status && migrationRow(status, button)
  const keyAccess = status?.ownerKeyAccess
  if (keyAccess || (!updating && (error || recovery || migration || message || action.error))) {
    return (
      <>
        <section className="space-y-2 pb-3">
          <SectionTitle small>Phosphor service</SectionTitle>
          {error && (
            <div role="alert">
              Couldn’t check the Phosphor service: {error} <Button onClick={reload}>Retry</Button>
            </div>
          )}
          {migration}
          {keyAccess && <OwnerKeyRow access={keyAccess} button={button} />}
          {recovery && !updating && (
            <>
              <p>
                Phosphor service unavailable.{' '}
                {status.service === 'attestation-failed'
                  ? 'Phosphor could not verify this service.'
                  : 'This Mac’s lanes stay on the service. They will reappear when it reconnects.'}
              </p>
              {status.notice !== 'dev-build' && button('start-service', 'Start service')}
              {!keyAccess && <Button onClick={retryService}>Retry</Button>}
            </>
          )}
          {(action.error || message) && <p role="status">{action.error || message}</p>}
        </section>
        {(machine !== 'local' || status?.mode === 'in-app') && children}
      </>
    )
  }
  return <>{(machine !== 'local' || status?.mode === 'in-app') && children}</>
}

/** Outside the Host gate: the service controls must remain reachable even before its first ready. */
export function LocalServiceSection({
  machine,
  children,
}: {
  machine: string
  children?: ReactNode
}) {
  const platform = usePlatform()
  const local = useRemoteLanesStore((s) => s.hosts[machine]?.local)
  if (
    !platform.localLanes ||
    (!local && machine !== 'local') ||
    !window.phosphor?.onLocalMachineChanged
  )
    return <>{children}</>
  return <ServiceCard machine={machine}>{children}</ServiceCard>
}
