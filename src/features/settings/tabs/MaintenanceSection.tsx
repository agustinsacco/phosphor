import { useCallback, useEffect, useState } from 'react'
import { Button, NumberField, Row, SectionTitle, Toggle } from '@/components/form'
import { DEFAULT_MAINTENANCE_PREFS } from '@shared/models'
import type { MaintenancePrefs, MaintenanceReport } from '@shared/models'
import { useActiveWorkspace } from '@/stores/workspaces'

/** Bytes as a short human string. `null` means the platform could not measure. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Storage reclamation, in Settings → Advanced.
 *
 * Scanning is safe and runs on open; reclaiming is a separate, explicit button
 * that reports what it deleted. The numbers are the point — a lane costs its
 * own `node_modules`, and nothing here was visible before.
 */
export function MaintenanceSection(): React.JSX.Element {
  const repoPath = useActiveWorkspace()
  const [prefs, setPrefs] = useState<MaintenancePrefs>(DEFAULT_MAINTENANCE_PREFS)
  const [report, setReport] = useState<MaintenanceReport | null>(null)
  const [busy, setBusy] = useState<'scan' | 'run' | null>(null)

  useEffect(() => {
    void window.pidex.invoke('app:getPrefs').then((p) => setPrefs(p.maintenance))
  }, [])

  const scan = useCallback(async () => {
    if (!repoPath) return
    setBusy('scan')
    try {
      setReport(await window.pidex.invoke('maintenance:scan', repoPath))
    } finally {
      setBusy(null)
    }
  }, [repoPath])

  useEffect(() => {
    void scan()
  }, [scan])

  const save = (next: MaintenancePrefs): void => {
    setPrefs(next)
    void window.pidex.invoke('maintenance:setPrefs', next)
  }

  const reclaim = async (): Promise<void> => {
    if (!repoPath) return
    setBusy('run')
    try {
      setReport(await window.pidex.invoke('maintenance:run', repoPath))
    } finally {
      setBusy(null)
    }
  }

  const candidates = report?.candidates.length ?? 0

  return (
    <div>
      <SectionTitle small>Maintenance</SectionTitle>

      <Row
        title="Reclaim dead lanes"
        description="Sweep periodically for worktrees whose branch already landed. Always measures; only deletes when the switch below is on."
      >
        <Toggle on={prefs.enabled} onChange={(enabled) => save({ ...prefs, enabled })} />
      </Row>

      <Row title="Sweep every" description="Minimum 15 minutes.">
        <NumberField
          value={prefs.intervalMinutes}
          onChange={(intervalMinutes) => save({ ...prefs, intervalMinutes })}
          min={15}
          max={1440}
          step={15}
          suffix="min"
        />
      </Row>

      <Row
        title="Leave lanes alone for"
        description="A merged lane is kept this long after its last use, in case you are still reading it."
      >
        <NumberField
          value={prefs.minAgeHours}
          onChange={(minAgeHours) => save({ ...prefs, minAgeHours })}
          min={1}
          max={720}
          step={1}
          suffix="hours"
        />
      </Row>

      <Row
        title="Delete automatically"
        description="Off by default. A reclaimed lane needs a fresh install to come back, so the sweep only reports until you turn this on."
      >
        <Toggle
          on={prefs.reclaimMergedWorktrees}
          onChange={(reclaimMergedWorktrees) => save({ ...prefs, reclaimMergedWorktrees })}
        />
      </Row>

      <Row
        title={
          report
            ? `${candidates} of ${report.worktreeCount} worktrees reclaimable`
            : 'Scanning worktrees…'
        }
        description={
          report
            ? candidates > 0
              ? `${formatBytes(report.reclaimableBytes)} on disk. Uncommitted, unmerged and in-use lanes are never touched.`
              : 'Nothing to reclaim. Every worktree is in use, unmerged, or holds uncommitted work.'
            : undefined
        }
      >
        <span className="flex gap-2">
          <Button onClick={() => void scan()} disabled={!repoPath || busy !== null}>
            {busy === 'scan' ? 'Scanning…' : 'Rescan'}
          </Button>
          <Button onClick={() => void reclaim()} disabled={busy !== null || candidates === 0}>
            {busy === 'run' ? 'Reclaiming…' : 'Reclaim now'}
          </Button>
        </span>
      </Row>

      {report && report.reclaimed.length > 0 && (
        <p className="text-success mt-2 text-sm">
          Reclaimed {report.reclaimed.length} worktree{report.reclaimed.length === 1 ? '' : 's'},
          freeing {formatBytes(report.reclaimedBytes)}.
        </p>
      )}
      {report && report.errors.length > 0 && (
        <p className="text-danger mt-2 font-mono text-sm">{report.errors[0]}</p>
      )}
    </div>
  )
}
