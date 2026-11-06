import clsx from 'clsx'
import { Button, Row, SectionTitle, SettingsNotice } from '@/components/form'
import type { PiResources } from '@shared/models'
import { SectionStatusNotice } from '../sectionStatus'
import { MaintenanceSection } from './MaintenanceSection'
import { MachineRuntimeRows } from './MachineRuntimeRows'
import type { AdvancedSource, PiFacts } from './source'

/**
 * pi health and the machine's own diagnostics, on every machine. This Mac adds
 * raw config editors, maintenance and loose resources; a Host adds its config
 * path and which environment names reach pi.
 */
export function AdvancedView({ source }: { source: AdvancedSource }): React.JSX.Element {
  const { caps, pi, path, environment, resources } = source
  return (
    <div>
      <SectionTitle>Advanced</SectionTitle>
      <SectionStatusNotice status={source.status} title="Couldn’t check pi" />
      {source.notice && <SettingsNotice {...source.notice} />}
      {source.runtime && <MachineRuntimeRows runtime={source.runtime} />}
      {pi !== undefined && <PiHealthRow pi={pi} />}
      {source.agentDir && (
        <Row title="pi agent directory" description="pi's settings, sessions and credentials.">
          <code className="font-mono text-sm">{source.agentDir}</code>
        </Row>
      )}
      {caps.rawFiles && source.editFile && <RawFileRows edit={source.editFile} />}
      {path && path.length > 0 && (
        <>
          <SectionTitle small>Executable search path</SectionTitle>
          <ul className="space-y-1">
            {path.map((entry, index) => (
              <li key={`${index}/${entry}`} className="break-all font-mono text-sm">
                {entry}
              </li>
            ))}
          </ul>
        </>
      )}
      {environment && <EnvironmentList environment={environment} />}
      {caps.maintenance && <MaintenanceSection />}
      {resources !== undefined && <LooseResources resources={resources} />}
      <p className="text-text-tertiary mt-3 text-sm">{source.footnote}</p>
      {source.dialog}
    </div>
  )
}

function PiHealthRow({ pi }: { pi: PiFacts | null }): React.JSX.Element {
  return (
    <Row
      title="pi health"
      description={pi ? `${pi.location} — minimum supported ${pi.minVersion}` : 'checking…'}
    >
      <span
        className={clsx(
          'rounded-md px-2 py-1 font-mono text-sm font-medium',
          pi?.ok ? 'bg-success/15 text-success' : 'bg-danger-soft text-danger',
        )}
      >
        {pi ? (pi.ok ? (pi.version ? `v${pi.version}` : 'found') : (pi.problem ?? 'error')) : '…'}
      </span>
    </Row>
  )
}

function RawFileRows({ edit }: { edit: (name: 'settings' | 'models') => void }): React.JSX.Element {
  return (
    <>
      <Row
        title="pi settings.json"
        description="Raw editor for ~/.pi/agent/settings.json. Restart sessions to apply."
      >
        <Button onClick={() => edit('settings')}>Edit…</Button>
      </Row>
      <Row
        title="pi models.json"
        description="Custom providers and models (local endpoints live here)."
      >
        <Button onClick={() => edit('models')}>Edit…</Button>
      </Row>
    </>
  )
}

function EnvironmentList({
  environment,
}: {
  environment: NonNullable<AdvancedSource['environment']>
}): React.JSX.Element {
  return (
    <>
      <SectionTitle small>Environment availability</SectionTitle>
      {environment.map((variable) => (
        <div key={variable.name} className="flex items-center justify-between gap-3 py-1.5">
          <code className="font-mono text-base">{variable.name}</code>
          <span
            className={clsx(
              'text-sm',
              variable.available && variable.passed ? 'text-success' : 'text-text-tertiary',
            )}
          >
            {variable.available && variable.passed
              ? 'Passed to pi'
              : variable.available
                ? 'Not passed'
                : 'Missing from service'}
          </span>
        </div>
      ))}
      {environment.length === 0 && (
        <p className="text-text-secondary text-base">
          No additional environment variables are allowlisted.
        </p>
      )}
    </>
  )
}

function LooseResources({ resources }: { resources: PiResources | null }): React.JSX.Element {
  return (
    <>
      <SectionTitle small>
        Local pi resources (loose files — packages are in the Extensions tab; skills have their own
        page: sidebar → Skills)
      </SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        {(['extensions', 'prompts', 'themes'] as const).map((kind) => (
          <div key={kind} className="border-border bg-surface rounded-xl border p-3">
            <div className="text-text-tertiary font-mono text-xs font-semibold uppercase tracking-wider">
              {kind}
            </div>
            <div className="mt-1.5 space-y-0.5">
              {(resources?.[kind] ?? []).slice(0, 8).map((name) => (
                <div key={name} className="truncate font-mono text-sm">
                  {name}
                </div>
              ))}
              {resources && resources[kind].length === 0 && (
                <div className="text-text-tertiary text-sm">none</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
