import { piInstallLocation, type PiHealth } from '@shared/models'
import { Button } from '@/components/form'
import type { PackageJobState } from '@/features/settings/usePackageJob'
import { JobOutput } from '@/features/settings/JobOutput'
import { PI_INSTALL } from '@/features/machines/machinePresentation'

/** This Mac's home while pi is missing or too old: install or update it in one click. */
export function PiMissingScreen({
  health,
  job,
  onInstall,
  onRetry,
}: {
  health: PiHealth
  /** The one-click install, owned by `useLocalSetup` so it outlives this screen. */
  job: PackageJobState
  onInstall: () => void
  onRetry: () => void
}): React.JSX.Element {
  const tooOld = health.reason === 'too-old'
  const title = tooOld ? 'pi needs an update' : 'pi is not installed'

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-8">
      <div className="bg-surface border-border w-full max-w-lg rounded-lg border p-8 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-text-secondary mt-3 text-lg leading-relaxed">
          Phosphor is powered by the pi coding agent. {health.message}
        </p>

        <div className="mt-6 flex items-center gap-3">
          <Button variant="primary" size="lg" onClick={onInstall} disabled={job.running}>
            {job.running ? 'Installing…' : tooOld ? 'Update pi' : 'Install pi'}
          </Button>
          <Button size="lg" onClick={onRetry} disabled={job.running}>
            Check again
          </Button>
        </div>

        <JobOutput running={job.running} output={job.output} exitCode={job.exitCode} />

        <p className="text-text-tertiary mt-5 text-base">Or install it yourself:</p>
        <div className="bg-code-bg border-border mt-1.5 rounded-md border px-4 py-3">
          <code className="font-mono text-lg">{PI_INSTALL}</code>
        </div>

        {health.version && (
          <p className="text-text-tertiary mt-3 text-base">
            Found version {health.version} at {piInstallLocation(health)} — minimum supported is{' '}
            {health.minVersion}.
          </p>
        )}
      </div>
    </div>
  )
}
