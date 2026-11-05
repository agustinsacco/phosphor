import { useEffect } from 'react'
import type { UpdateState } from '@shared/models'
import { useUpdatesStore } from './updatesStore'

/** A machine's update action: one line about it, and the button that runs it. */
export interface MachineUpdate {
  /** Says when the machine cannot run it. */
  note: string
  action: string
  primary?: boolean
  disabled: boolean
  run: () => void
}

/**
 * What the app's update row says. The update pill shows only something to act
 * on, so this row is how to ask whether the app is current.
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

/**
 * This app's own update: Check now, or Restart / Download once there is one.
 * Follows the update events only while `enabled` (the platform's `appInfo`).
 */
export function useAppUpdate(enabled = true): MachineUpdate {
  const update = useUpdatesStore((s) => s.update)
  // The pill owns the subscription while it is mounted, but it unmounts
  // whenever there is nothing to show — which is exactly when this row is most
  // likely to be open.
  useEffect(() => (enabled ? useUpdatesStore.getState().subscribe() : undefined), [enabled])
  const note = updateSummary(update)
  if (update.phase === 'downloaded' || update.phase === 'manual-download')
    return {
      note,
      action: update.phase === 'downloaded' ? 'Restart to update' : 'Download',
      primary: true,
      disabled: false,
      run: () => void useUpdatesStore.getState().restartAndInstall(),
    }
  return {
    note,
    action: 'Check now',
    disabled:
      update.phase === 'checking' ||
      update.phase === 'downloading' ||
      update.phase === 'unsupported',
    run: () => void useUpdatesStore.getState().check(),
  }
}
