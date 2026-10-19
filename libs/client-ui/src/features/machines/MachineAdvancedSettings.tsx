import { Card, Fact, Facts, StatusPill } from './MachineUi'
import type { HostSettingsState } from './useHostSettings'

export function MachineAdvancedSettings({
  label,
  settings,
}: {
  label: string
  settings: HostSettingsState
}): React.JSX.Element | null {
  const runtime = settings.data?.advanced
  if (!runtime) return null
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Advanced</h2>
        <p className="text-text-secondary mt-1 text-base">
          Read-only execution diagnostics from {label}. Secret values are never returned.
        </p>
      </div>
      <Card title="Runtime">
        <Facts>
          <Fact label="Platform">{runtime.platform}</Fact>
          <Fact label="Host version">{runtime.hostVersion}</Fact>
          <Fact label="Host config">
            <code className="font-mono text-sm">{runtime.configPath}</code>
          </Fact>
          <Fact label="pi agent directory">
            <code className="font-mono text-sm">{runtime.piAgentDir}</code>
          </Fact>
        </Facts>
      </Card>
      <Card title="Environment availability">
        {runtime.environment.map((variable) => (
          <div key={variable.name} className="flex items-center justify-between gap-3 py-2">
            <code className="font-mono text-base">{variable.name}</code>
            <StatusPill tone={variable.available && variable.passed ? 'ok' : 'off'}>
              {variable.available && variable.passed
                ? 'Passed to pi'
                : variable.available
                  ? 'Not passed'
                  : 'Missing from service'}
            </StatusPill>
          </div>
        ))}
        {!runtime.environment.length && (
          <p className="text-text-secondary text-base">
            No additional environment variables are allowlisted.
          </p>
        )}
        <p className="text-text-tertiary mt-3 text-sm">
          Set secret values in the Host service’s environment, not in this page or the control
          plane. An interactive SSH shell’s variables may differ from the service.
        </p>
      </Card>
      <Card title="Executable search path">
        <ul className="space-y-1">
          {runtime.path.map((path, index) => (
            <li key={`${index}/${path}`} className="break-all font-mono text-sm">
              {path}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
