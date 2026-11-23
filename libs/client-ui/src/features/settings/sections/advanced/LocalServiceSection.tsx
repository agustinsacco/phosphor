import type { ReactNode } from 'react'
import type { LocalMachineAction, LocalMachineStatus } from '@phosphor/shared/ipc'
import { Button, Row } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { useServiceAction, laneCount } from '@/features/updates/useServiceAction'
import { hostTasks } from '@/features/machines/runningTasks'
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

function migrationRow(status: LocalMachineStatus, button: Click) {
  if (status.mode === 'in-app' && status.migration === 'committed')
    return (
      <Row title="Restart to finish setting up this Mac">
        {button('restart-to-finish', 'Restart Phosphor')}
      </Row>
    )
  switch (status.migration) {
    case 'failed':
      return (
        <Row
          title="Couldn’t finish setting up the Phosphor service"
          description={
            status.failure && (
              <details>
                <TooltipSummary>Setup details</TooltipSummary>
                {status.failure.step}: {status.failure.code}
              </details>
            )
          }
        >
          {button('retry-migration', 'Retry')}
          {button('export-diagnostics', 'Export diagnostics')}
        </Row>
      )
    case 'consent-needed':
      return (
        <Row title="Service setup needs your attention" description={notice['other-daemon']}>
          {button('consent-migration', 'Continue setup')}
        </Row>
      )
    case 'reverted':
      return <Row title="Service setup was reverted">{button('retry-migration', 'Retry')}</Row>
    case 'repairing':
    case 'running':
      return <Row title="Setting up the Phosphor service">{status.step}</Row>
    default:
      return status.notice && <p>{notice[status.notice]}</p>
  }
}

function ServiceRows({
  status,
  working,
  button,
  reload,
}: {
  status: LocalMachineStatus
  working: number | undefined
  button: Click
  reload(): void
}) {
  if (status.mode !== 'daemon') return null
  if (status.service !== 'ready')
    return (
      <Row
        title="Phosphor service unavailable"
        description={
          status.service === 'attestation-failed'
            ? 'Phosphor could not verify this service.'
            : 'This Mac’s lanes stay on the service. They will reappear when it reconnects.'
        }
      >
        {status.notice !== 'dev-build' && button('start-service', 'Start service')}
        <Button onClick={reload}>Retry</Button>
      </Row>
    )
  const pause = status.pause
  if (pause?.kind === 'pausing')
    return (
      <Row
        title="Waiting to pause for the update"
        description={`${pause.waitingOn.turns} turns, ${pause.waitingOn.subagents} sub-agents and ${pause.waitingOn.routines} routines remaining. Abort now saves and stops unfinished turns. Cancel leaves the update unapplied.`}
      >
        {button('update-abort-now', 'Abort now')}
        {button('update-cancel', 'Cancel')}
      </Row>
    )
  if (pause?.kind === 'paused')
    return (
      <Row title="Lanes paused for the service update">The service is applying the update.</Row>
    )
  return (
    <Row
      title="Phosphor service"
      description={`${status.serviceVersion ? `Version ${status.serviceVersion}. ` : ''}${laneCount(working)}. Lanes keep running after Desktop quits.`}
    >
      {button('update-service', 'Update Phosphor service')}
    </Row>
  )
}

function ServiceCard({ machine, children }: { machine: string; children?: ReactNode }) {
  const { status, error, reload } = useLocalServiceStatus()
  const working = useRemoteLanesStore((s) => {
    const id = localServiceId(s.hosts)
    return id && s.hosts[id]?.state === 'ready' ? hostTasks(id, s.hosts[id]).length : undefined
  })
  const action = useServiceAction(status, working, reload)
  const button: Click = (name, label) => (
    <Button disabled={action.busy} onClick={() => action.invoke(name)}>
      {action.failed && name === 'update-service' ? 'Update again' : label}
    </Button>
  )
  return (
    <>
      {error && (
        <div role="alert">
          Couldn’t check the Phosphor service: {error} <Button onClick={reload}>Retry</Button>
        </div>
      )}
      {status && migrationRow(status, button)}
      {status && <ServiceRows status={status} working={working} reload={reload} button={button} />}
      {action.message && <p role="status">{action.message}</p>}
      {(machine !== 'local' || status?.mode === 'in-app') && children}
    </>
  )
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
