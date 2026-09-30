import {
  AGENT_INSTALL_COMMANDS,
  piInstallLocation,
  type AgentKind,
  type PiHealth,
} from '@shared/models'
import { Button } from '@/components/form'
import { usePackageJob } from '@/features/settings/usePackageJob'
import { JobOutput } from '@/features/settings/JobOutput'

export function PiMissingScreen({
  health,
  onRetry,
  onInstalled,
}: {
  health: PiHealth
  onRetry: () => void
  /** Called when the one-click install finishes successfully (fresh setup). */
  onInstalled: () => void
}): React.JSX.Element {
  const agent = health.agent
  const tooOld = health.reason === 'too-old'
  const title = tooOld ? `${agent} needs an update` : `${agent} is not installed`

  // This screen gates the whole app, Settings included, so switching to the
  // other agent has to be possible from here in both directions.
  const otherAgent: AgentKind = agent === 'pi' ? 'omp' : 'pi'
  const switchTo = async (kind: AgentKind): Promise<void> => {
    const prefs = await window.phosphor.invoke('app:getPrefs')
    await window.phosphor.invoke('app:setAgent', { ...prefs.agent, kind })
    window.location.reload()
  }

  const job = usePackageJob((exitCode) => {
    if (exitCode === 0) {
      onInstalled()
      onRetry()
    }
  })

  return (
    <div className="titlebar-drag flex h-full flex-col items-center justify-center gap-6 px-8">
      <div className="bg-surface border-border w-full max-w-lg rounded-lg border p-8 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-text-secondary mt-3 text-lg leading-relaxed">
          Phosphor is powered by the {agent} coding agent. {health.message}
        </p>

        <div className="mt-6 flex items-center gap-3">
          {/* The one-click install is pi's npm package; omp installs with bun. */}
          {agent === 'pi' ? (
            <Button
              variant="primary"
              size="lg"
              onClick={() => void job.start(() => window.phosphor.invoke('packages:installPi'))}
              disabled={job.running}
            >
              {job.running ? 'Installing…' : tooOld ? 'Update pi' : 'Install pi'}
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => void switchTo(otherAgent)}>
              Use {otherAgent} instead
            </Button>
          )}
          {agent === 'pi' && (
            <Button size="lg" onClick={() => void switchTo(otherAgent)} disabled={job.running}>
              Use {otherAgent} instead
            </Button>
          )}
          <Button size="lg" onClick={onRetry} disabled={job.running}>
            Check again
          </Button>
        </div>

        <JobOutput running={job.running} output={job.output} exitCode={job.exitCode} />

        <p className="text-text-tertiary mt-5 text-base">Or install it yourself:</p>
        <div className="bg-code-bg border-border mt-1.5 rounded-md border px-4 py-3">
          <code className="font-mono text-lg">{AGENT_INSTALL_COMMANDS[agent]}</code>
        </div>

        {health.version && health.minVersion && (
          <p className="text-text-tertiary mt-3 text-base">
            Found version {health.version} at {piInstallLocation(health)} — minimum supported is{' '}
            {health.minVersion}.
          </p>
        )}
      </div>
    </div>
  )
}
