import { Button, Row, SectionTitle } from '@/components/form'
import { PhosphorLockup } from '@/components/PhosphorMark'
import type { AboutInfo } from '@shared/models'
import { piInstallLocation, type PiHealth, type UpdateState } from '@shared/models'
import { useEffect, useState } from 'react'
import { useUpdatesStore } from '@/features/updates/updatesStore'
import { VERIFIED_PI_LINE, isPiNewerThanVerified } from '@/lib/piDrift'
import interLicense from '@/assets/fonts/Inter-OFL.txt?raw'
import monoLicense from '@/assets/fonts/JetBrainsMono-OFL.txt?raw'

/** App and runtime versions, an update check, and a pi version-drift warning. */

/**
 * The update pill only appears once there is something to act on, so until
 * this row existed there was no way to ask "am I current?" — and no caller for
 * `updates:check` at all, on any surface.
 */
function updateSummary(update: UpdateState): string {
  switch (update.phase) {
    case 'checking':
      return 'Checking…'
    case 'downloading':
      return `Downloading ${update.version ?? ''} ${update.progressPercent ?? 0}%`.trim()
    case 'installing':
      return `Installing ${update.version ?? ''}`.trim()
    case 'downloaded':
      return `${update.version} ready — restart to apply`
    case 'manual-download':
      return `${update.version} available — install by hand`
    case 'unsupported':
      return 'Not available in this build'
    default:
      return 'Up to date'
  }
}

export function AboutTab(): React.JSX.Element {
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [health, setHealth] = useState<PiHealth | null>(null)
  const update = useUpdatesStore((s) => s.update)

  useEffect(() => {
    void window.phosphor.invoke('app:about').then(setAbout)
    void window.phosphor.invoke('pi:health').then(setHealth)
  }, [])

  // The pill owns the subscription while it is mounted, but it unmounts
  // whenever there is nothing to show — which is exactly when this tab is most
  // likely to be open.
  useEffect(() => useUpdatesStore.getState().subscribe(), [])

  const busy = update.phase === 'checking' || update.phase === 'downloading'
  const actionable = update.phase === 'downloaded' || update.phase === 'manual-download'

  const drift = isPiNewerThanVerified(health?.version)

  return (
    <div>
      {/* The only place the app draws its own mark. Every identity since
          2026-08-07 specified an in-app variant and none shipped one. The
          lockup IS the panel's heading — dropping the h2 for it would leave
          this tab as the one settings panel with no heading. */}
      <SectionTitle>
        <PhosphorLockup />
      </SectionTitle>
      <p className="text-text-secondary -mt-2 mb-4 text-base leading-relaxed">
        A desktop coding-agent app powered by the{' '}
        <span className="font-medium">pi coding agent</span>. Sessions run as real{' '}
        <code className="font-mono">pi --mode rpc</code> subprocesses in your workspace.
      </p>

      <Row title="Phosphor version">
        <span className="font-mono text-base">{about?.appVersion ?? '…'}</span>
      </Row>
      <Row title="Updates" description={updateSummary(update)}>
        {actionable ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void useUpdatesStore.getState().restartAndInstall()}
          >
            {update.phase === 'downloaded' ? 'Restart to update' : 'Download'}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || update.phase === 'unsupported'}
            onClick={() => void useUpdatesStore.getState().check()}
          >
            Check now
          </Button>
        )}
      </Row>
      <Row title="pi version" description={health ? piInstallLocation(health) : undefined}>
        <span className="font-mono text-base">
          {health?.version ?? (health ? 'not found' : '…')}
        </span>
      </Row>
      <Row title="Platform">
        <span className="font-mono text-base">
          {about ? `${about.platform}-${about.arch}` : '…'}
        </span>
      </Row>
      <Row title="Runtime">
        <span className="font-mono text-base">
          {about ? `Electron ${about.electron} · Node ${about.node}` : '…'}
        </span>
      </Row>

      <details className="mt-4 text-base">
        <summary>Bundled font licenses</summary>
        <pre className="text-text-secondary mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm">
          {`${interLicense}\n\n${monoLicense}`}
        </pre>
      </details>

      {drift && (
        <div className="bg-warning/10 border-warning/30 mt-4 rounded-lg border px-3.5 py-2.5 text-base">
          <span className="font-medium">pi {health?.version} is newer than tested.</span>{' '}
          <span className="text-text-secondary">
            Phosphor is verified against pi {VERIFIED_PI_LINE}.x. Newer minors usually work, but
            protocol additions may not be surfaced yet.
          </span>
        </div>
      )}
    </div>
  )
}
