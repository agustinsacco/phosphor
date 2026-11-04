import { useState, type ReactNode } from 'react'
import type { PiHealth } from '@shared/models'
import { PiMissingScreen } from './PiMissingScreen'
import { GettingStartedScreen } from './GettingStartedScreen'
import { WorkspacePicker } from './WorkspacePicker'

/**
 * What takes This Mac's home while it cannot start a lane: pi missing or too
 * old, the one-time recommendations after Phosphor installed pi, or no folder
 * open. Only local lane creation waits on it. The shell stays mounted around
 * it, so Machines, Host lanes and Settings stay reachable. Null once This Mac
 * can start a lane, and while pi's health is still unknown.
 */
export function useLocalSetup(
  health: PiHealth | null,
  workspacePath: string | null,
  recheckHealth: () => void,
): ReactNode | null {
  const [gettingStarted, setGettingStarted] = useState(false)
  if (!health) return null
  if (!health.ok)
    return (
      <PiMissingScreen
        health={health}
        onRetry={recheckHealth}
        onInstalled={() => setGettingStarted(true)}
      />
    )
  if (gettingStarted) return <GettingStartedScreen onDone={() => setGettingStarted(false)} />
  if (!workspacePath) return <WorkspacePicker piVersion={health.version} />
  return null
}
