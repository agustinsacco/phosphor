import { useState, type ReactNode } from 'react'
import type { PiHealth } from '@shared/models'
import { PiMissingScreen } from './PiMissingScreen'
import { GettingStartedScreen } from './GettingStartedScreen'
import { WorkspacePicker } from './WorkspacePicker'
import { usePackageJob } from '@/features/settings/usePackageJob'

/**
 * What takes This Mac's home while it cannot start a lane: pi missing or too
 * old, the one-time recommendations after Phosphor installed pi, or no folder
 * open. Only local lane creation waits on it. The shell stays mounted around
 * it, so Machines, Host lanes and Settings stay reachable. Null once This Mac
 * can start a lane, and while pi's health is still unknown. The install job lives
 * here, not in the screen, so it is still heard after the user leaves the home.
 * `gettingStarted` holds the launch restore, which would otherwise open the last
 * session over the recommendations.
 */
export function useLocalSetup(
  health: PiHealth | null,
  workspacePath: string | null,
  recheckHealth: () => void,
): { setup: ReactNode | null; gettingStarted: boolean } {
  const [gettingStarted, setGettingStarted] = useState(false)
  const install = usePackageJob((exitCode) => {
    if (exitCode !== 0) return
    setGettingStarted(true)
    recheckHealth()
  })
  return { setup: setupFor(), gettingStarted }

  function setupFor(): ReactNode | null {
    if (!health) return null
    if (!health.ok)
      return (
        <PiMissingScreen
          health={health}
          job={install}
          onInstall={() => void install.start(() => window.phosphor.invoke('packages:installPi'))}
          onRetry={recheckHealth}
        />
      )
    if (gettingStarted) return <GettingStartedScreen onDone={() => setGettingStarted(false)} />
    if (!workspacePath) return <WorkspacePicker piVersion={health.version} />
    return null
  }
}
