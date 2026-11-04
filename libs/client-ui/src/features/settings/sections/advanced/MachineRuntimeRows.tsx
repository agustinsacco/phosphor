import { useEffect } from 'react'
import { Button, Row } from '@/components/form'
import type { UpdateState } from '@shared/models'
import { useUpdatesStore } from '@/features/updates/updatesStore'
import type { MachineRuntime, MachineUpdate } from './source'

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

/** A machine's update action, with one line about it. */
export function MachineUpdateRow({
  title,
  update,
}: {
  title: string
  update: MachineUpdate
}): React.JSX.Element {
  return (
    <Row title={title} description={update.note}>
      <Button
        variant={update.primary ? 'primary' : undefined}
        disabled={update.disabled}
        onClick={update.run}
      >
        {update.action}
      </Button>
    </Row>
  )
}

/** Each product's row titles, written out so Settings search indexes them. */
const RUNTIME_TITLES = {
  Phosphor: { update: 'Phosphor updates', version: 'Phosphor version' },
  Host: { update: 'Host updates', version: 'Host version' },
} as const

/** What runs the machine: its update, version and platform, and a Host's config file. */
export function MachineRuntimeRows({ runtime }: { runtime: MachineRuntime }): React.JSX.Element {
  const titles = RUNTIME_TITLES[runtime.product]
  return (
    <>
      <MachineUpdateRow title={titles.update} update={runtime.update} />
      <Row title={titles.version} description={runtime.platform}>
        <code className="font-mono text-sm">{runtime.version}</code>
      </Row>
      {runtime.configPath && (
        <Row title="Host config" description="Folders, policy and the allowlisted environment.">
          <code className="break-all font-mono text-sm">{runtime.configPath}</code>
        </Row>
      )}
    </>
  )
}
