import { TooltipSummary } from '@/components/Tooltip'
import { Row, SectionTitle } from '@/components/form'
import { PhosphorLockup } from '@/components/PhosphorMark'
import { piInstallLocation, type PiHealth } from '@shared/models'
import { useEffect, useState } from 'react'
import { usePlatform } from '@/platform/Platform'
import { MachineUpdateRow, useAppUpdate } from '../sections/advanced/MachineRuntimeRows'
import { useAboutInfo } from '../sections/advanced/useLocalAdvanced'
import { VERIFIED_PI_LINE, isPiNewerThanVerified } from '@/lib/piDrift'
import interLicense from '@/assets/fonts/Inter-OFL.txt?raw'
import monoLicense from '@/assets/fonts/JetBrainsMono-OFL.txt?raw'

/** App and runtime versions, an update check, and a pi version-drift warning. */

export function AboutTab(): React.JSX.Element {
  const { appInfo } = usePlatform()
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
        A coding-agent app powered by the <span className="font-medium">pi coding agent</span>. Each
        session runs as a real <code className="font-mono">pi --mode rpc</code> subprocess on its
        machine.
      </p>

      {appInfo && <AppInfoRows />}

      <details className="mt-4 text-base">
        <TooltipSummary>Bundled font licenses</TooltipSummary>
        <pre className="text-text-secondary mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm">
          {`${interLicense}\n\n${monoLicense}`}
        </pre>
      </details>
    </div>
  )
}

/** Versions, update checks and pi drift, read from the native app. */
function AppInfoRows(): React.JSX.Element {
  const read = useAboutInfo(true)
  const about = read === 'unknown' ? null : read
  const pending = read === 'unknown' ? 'unknown' : '…'
  const [health, setHealth] = useState<PiHealth | null>(null)
  const update = useAppUpdate()

  useEffect(() => {
    void window.phosphor.invoke('pi:health').then(setHealth)
  }, [])

  const drift = isPiNewerThanVerified(health?.version)

  return (
    <>
      <Row title="Phosphor version">
        <span className="font-mono text-base">{about?.appVersion ?? pending}</span>
      </Row>
      <MachineUpdateRow title="Updates" update={update} />
      <Row title="pi version" description={health ? piInstallLocation(health) : undefined}>
        <span className="font-mono text-base">
          {health?.version ?? (health ? 'not found' : '…')}
        </span>
      </Row>
      <Row title="Platform">
        <span className="font-mono text-base">
          {about ? `${about.platform}-${about.arch}` : pending}
        </span>
      </Row>
      <Row title="Runtime">
        <span className="font-mono text-base">
          {about ? `Electron ${about.electron} · Node ${about.node}` : pending}
        </span>
      </Row>

      {drift && (
        <div className="bg-warning/10 border-warning/30 mt-4 rounded-lg border px-3.5 py-2.5 text-base">
          <span className="font-medium">pi {health?.version} is newer than tested.</span>{' '}
          <span className="text-text-secondary">
            Phosphor is verified against pi {VERIFIED_PI_LINE}.x. Newer minors usually work, but
            protocol additions may not be surfaced yet.
          </span>
        </div>
      )}
    </>
  )
}
