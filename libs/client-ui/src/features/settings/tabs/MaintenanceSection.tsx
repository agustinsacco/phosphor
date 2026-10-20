import { useCallback, useEffect, useState } from 'react'
import { Button, NumberField, Row, SectionTitle, Toggle } from '@/components/form'
import { DEFAULT_MAINTENANCE_PREFS } from '@shared/models'
import type { MaintenancePrefs, MaintenanceReport, ReclaimHoldReason } from '@shared/models'
import { workspaceName } from '@/lib/path'

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

/** One sweep's worth of numbers, summed across every workspace's report. */
export function combineReports(reports: MaintenanceReport[]): {
  worktreeCount: number
  candidates: number
  reclaimableBytes: number
  reclaimed: number
  reclaimedBytes: number
  errors: string[]
} {
  return {
    worktreeCount: reports.reduce((n, r) => n + r.worktreeCount, 0),
    candidates: reports.reduce((n, r) => n + r.candidates.length, 0),
    reclaimableBytes: reports.reduce((n, r) => n + r.reclaimableBytes, 0),
    reclaimed: reports.reduce((n, r) => n + r.reclaimed.length, 0),
    reclaimedBytes: reports.reduce((n, r) => n + r.reclaimedBytes, 0),
    errors: reports.flatMap((r) => r.errors.map((e) => `${workspaceName(r.workspacePath)}: ${e}`)),
  }
}

/** Hold reasons in the order the policy checks them. The main checkout is never a lane. */
const HOLD_LABELS: Array<[ReclaimHoldReason, string]> = [
  ['no-branch', 'detached'],
  ['dirty', 'uncommitted'],
  ['in-use', 'in use'],
  ['unfinished', 'unfinished conversations'],
  ['pinned', 'pinned'],
  ['locked', 'locked'],
  ['unmerged', 'not landed'],
  ['too-recent', 'recently used'],
]

/** Why every lane that is not a candidate was kept, e.g. `4 uncommitted, 12 not landed`. */
export function heldSummary(reports: MaintenanceReport[], minAgeHours: number): string {
  const count = (reason: ReclaimHoldReason): number =>
    reports.reduce((n, r) => n + r.held.filter((h) => h.reason === reason).length, 0)
  return HOLD_LABELS.map(([reason, label]) => [count(reason), label] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}${label === 'recently used' ? ` (<${minAgeHours}h)` : ''}`)
    .join(', ')
}

/**
 * Storage reclamation, in Settings → Advanced.
 *
 * Scanning is safe and runs on open; reclaiming is a separate, explicit button
 * that reports what it deleted. The numbers are the point — a lane costs its
 * own `node_modules`, and nothing here was visible before.
 *
 * Covers every workspace the scheduled sweep does. It used to cover only the
 * active one, so "Reclaim now" freed one repo's lanes and silently left the
 * rest — tens of gigabytes across six other repos on one install.
 */
export function MaintenanceSection(): React.JSX.Element {
  const [prefs, setPrefs] = useState<MaintenancePrefs>(DEFAULT_MAINTENANCE_PREFS)
  const [reports, setReports] = useState<MaintenanceReport[] | null>(null)
  const [busy, setBusy] = useState<'scan' | 'run' | null>(null)

  useEffect(() => {
    void window.phosphor.invoke('app:getPrefs').then((p) => setPrefs(p.maintenance))
  }, [])

  const scan = useCallback(async () => {
    setBusy('scan')
    try {
      setReports(await window.phosphor.invoke('maintenance:scan'))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const save = (next: MaintenancePrefs): void => {
    setPrefs(next)
    void window.phosphor.invoke('maintenance:setPrefs', next)
  }

  const reclaim = async (): Promise<void> => {
    setBusy('run')
    try {
      setReports(await window.phosphor.invoke('maintenance:run'))
    } finally {
      setBusy(null)
    }
  }

  const report = reports ? combineReports(reports) : null
  const candidates = report?.candidates ?? 0
  const withCandidates = (reports ?? []).filter((r) => r.candidates.length > 0)
  const held = reports ? heldSummary(reports, prefs.minAgeHours) : ''

  return (
    <div>
      <SectionTitle small>Maintenance</SectionTitle>

      <Row
        title="Reclaim dead lanes"
        description="Sweep for explicitly finished conversations whose code landed. Unknown and unfinished conversations are always kept."
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
        description="Keep a finished lane this long after completion or its latest conversation activity, whichever is later."
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
              ? `${formatBytes(report.reclaimableBytes)} on disk across ${withCandidates.length} workspace${withCandidates.length === 1 ? '' : 's'}. Unfinished, pinned, locked, uncommitted and in-use lanes are never touched.`
              : `Nothing to reclaim.${held ? ` Kept: ${held}.` : ''}`
            : undefined
        }
      >
        <span className="flex gap-2">
          <Button onClick={() => void scan()} disabled={busy !== null}>
            {busy === 'scan' ? 'Scanning…' : 'Rescan'}
          </Button>
          <Button onClick={() => void reclaim()} disabled={busy !== null || candidates === 0}>
            {busy === 'run' ? 'Reclaiming…' : 'Reclaim now'}
          </Button>
        </span>
      </Row>

      {withCandidates.length > 0 && (
        <ul className="text-text-secondary mt-2 space-y-0.5 text-sm">
          {withCandidates.map((r) => (
            <li key={r.workspacePath} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate" data-tooltip={r.workspacePath}>
                {workspaceName(r.workspacePath)}
              </span>
              <span>
                {r.candidates.length} · {formatBytes(r.reclaimableBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {report && report.reclaimed > 0 && (
        <p className="text-success mt-2 text-sm">
          Reclaimed {report.reclaimed} worktree{report.reclaimed === 1 ? '' : 's'}, freeing{' '}
          {formatBytes(report.reclaimedBytes)}.
        </p>
      )}
      {report && report.errors.length > 0 && (
        <p className="text-danger mt-2 font-mono text-sm">{report.errors[0]}</p>
      )}
    </div>
  )
}
