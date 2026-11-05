import clsx from 'clsx'
import { Fragment } from 'react'
import type { MachineView } from '@shared/control-api'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/form'
import { Spinner } from '@/components/icons'
import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { CopyCommand, Troubleshooting } from './MachineControls'
import { MachineDetailHeader } from './MachineDetailHeader'
import { MachineFilesButton } from './MachineFilesButton'
import { useHostOverview, type MachineOverview } from './machineOverview'
import { HOST_SERVICE_STATUS, relativeTime } from './machinePresentation'
import { Card, CheckRow } from './MachineUi'
import { MachineTerminal } from './MachineTerminal'
import { OnThisMachine } from './OnThisMachine'
import { MachineProviders } from './MachineProviders'

/** One detail for any machine, This Mac or a Host. What a machine lacks is not drawn. */
export function MachineDetail({
  overview,
  onRemove,
}: {
  overview: MachineOverview
  /** Offered for an enrolled Host. */
  onRemove?: () => void
}): React.JSX.Element {
  const { id, label, check, note } = overview
  const stamp = [
    overview.reported,
    check.at ? `checked ${relativeTime(new Date(check.at).toISOString(), Date.now())}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div data-testid="machine-detail" className="space-y-4">
      <MachineDetailHeader overview={overview} />
      <MachineViews overview={overview} />
      {overview.notice === 'setup' && (
        <section
          aria-label="Finish setup"
          className="border-border bg-bg-secondary space-y-3 rounded-lg border p-4"
        >
          <div className="flex items-center gap-2">
            <Spinner className="text-text-tertiary" />
            <h2 className="text-lg font-semibold">Waiting for {label} to finish setup</h2>
          </div>
          <p className="text-text-secondary text-base">
            This page updates on its own once {label} checks in. If setup stopped, run it again on{' '}
            {label}; it resumes where it left off.
          </p>
          <CopyCommand command="phosphor setup" />
          <Troubleshooting />
        </section>
      )}
      {overview.notice === 'offline' && (
        <section
          aria-label="Offline"
          className="border-border space-y-3 rounded-lg border p-4 text-base"
        >
          <p className="text-text-secondary">
            Offline for more than a day. Check the service on {label}.
          </p>
          <CopyCommand command={HOST_SERVICE_STATUS} />
        </section>
      )}

      {/* Two stacks, not a row-by-row grid: a tall Readiness card leaves no hole beside it. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card
            title="Readiness"
            aside={
              check.busy ? (
                <>
                  <Spinner className="text-text-tertiary" /> Checking
                </>
              ) : (
                stamp && <span role="status">{stamp}</span>
              )
            }
          >
            {overview.checks.map((item) => (
              <CheckRow key={item.name} check={item} />
            ))}
            {note && (
              <p
                role={note.alert ? 'alert' : undefined}
                className={clsx(
                  'py-1.5 text-base',
                  note.alert ? 'text-danger' : 'text-text-secondary',
                )}
              >
                {note.text}
              </p>
            )}
          </Card>
          {overview.connected && (
            <Card title="On this machine">
              <OnThisMachine hostId={id} refresh={check.round} />
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card title="Providers">
            <MachineProviders
              key={id}
              hostId={id}
              refresh={check.round}
              onConfigure={overview.configure}
            />
          </Card>
          <MachineFacts facts={overview.facts} />
        </div>
      </div>
      {overview.connected && <MachineTerminal hostId={id} label={label} />}

      {onRemove && (
        <section
          aria-label="Remove machine"
          className="border-border flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3"
        >
          <p className="text-text-secondary min-w-0 flex-1 text-base">
            Remove this machine from your account. Lanes, routines and files stay on the machine and
            return when you add it again.
          </p>
          <Button size="sm" variant="danger" onClick={onRemove}>
            Remove machine
          </Button>
        </section>
      )}
    </div>
  )
}

/** A Host's detail, read from its directory entry and live connection. */
export function HostMachineDetail({
  machine,
  now,
  offset,
  ...rest
}: {
  machine: MachineView
  now: number
  offset: number
  onRemove: () => void
}): React.JSX.Element {
  return <MachineDetail overview={useHostOverview(machine, now, offset)} {...rest} />
}

/** The same views for every machine: this Overview, its Settings and its files. */
function MachineViews({ overview }: { overview: MachineOverview }): React.JSX.Element {
  const openSettings = useOpenSettings()
  return (
    <nav aria-label="Machine views" className="border-border flex gap-5 border-b">
      <TooltipButton
        tooltip="Machine readiness and diagnostics"
        aria-current="page"
        className="machine-view-tab text-base"
      >
        Overview
      </TooltipButton>
      <TooltipButton
        tooltip={`Configure ${overview.label} in Settings`}
        aria-label="Machine settings"
        className="machine-view-tab text-base"
        onClick={() => openSettings(overview.id, 'accounts')}
      >
        Settings
      </TooltipButton>
      <MachineFilesButton machine={overview} />
    </nav>
  )
}

function MachineFacts({ facts }: { facts: MachineOverview['facts'] }): React.JSX.Element {
  return (
    <details className="machine-facts">
      <TooltipSummary>Details</TooltipSummary>
      <div className="bg-surface border-border rounded-lg border px-4 py-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-base">
          {facts.map(({ label, value, copy }) => (
            <Fragment key={label}>
              <dt className="text-text-tertiary">{label}</dt>
              <dd className="min-w-0 truncate">
                {copy ? (
                  <span className="flex items-center gap-1">
                    <code className="truncate font-mono text-sm">{value}</code>
                    <CopyButton size="icon" text={value} title={`Copy ${label.toLowerCase()}`} />
                  </span>
                ) : (
                  value
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </details>
  )
}
