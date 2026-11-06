import { useEffect, useRef, useState } from 'react'
import { machineStatus, type MachineStatus, type MachineView } from '@shared/control-api'
import type { HostConnectionView } from '@shared/ipc'
import type { AboutInfo } from '@shared/models'
import type { TailscaleStatus } from '@shared/tailscale-status'
import { platformName } from '@shared/platform-name'
import { localMachineLabel } from '@/lib/localMachine'
import { usePlatform } from '@/platform/Platform'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import {
  claudeReadiness,
  localChecks,
  readinessChecks,
  readinessFreshness,
  readLocalClaude,
  relativeTime,
  type LocalReadings,
  type ReadinessCheck,
} from './machinePresentation'
import { machineHeadline, type Headline } from './machineReachability'
import { localLiveEntries } from './localLive'
import { useLocalTasks } from './MachineTasks'
import { useHostClaude } from './useHostClaude'
import { useHostPiVersion } from './useHostPiVersion'
import { hostTasks, taskCounts, type MachineTask } from './runningTasks'

const DAY_MS = 86_400_000

/** What a Machines row shows, for This Mac or a Host. */
export interface MachineSummary {
  /** `'local'` for this computer, as everywhere else in the app; otherwise the Host's id. */
  id: string
  label: string
  /** The enrolled Host's directory entry: rename, heartbeat, setup notices and removal. */
  machine?: MachineView
  status?: MachineStatus
  headline: Headline
  meta: string[]
  /** The row's readiness dots; null while the report is too old to summarise. */
  dots: ReadinessCheck[] | null
  tasks: MachineTask[]
}

/** Re-read on demand: `round` counts finished checks, `at` is when the last one ended. */
export interface Recheck {
  busy: boolean
  at: number | null
  round: number
  run: () => void
}

/** One machine's detail. Capabilities are data: a missing action is not offered. */
export interface MachineOverview extends MachineSummary {
  /** The header's second line; `history` hides on narrow screens. */
  about: string
  history?: string
  checks: ReadinessCheck[]
  /** One line under the checks: why they are missing, old, or incomplete. */
  note?: { text: string; alert?: boolean }
  /** When the machine last reported its checks; only a Host reports. */
  reported?: string
  facts: { label: string; value: string; copy?: boolean }[]
  /** Lanes and a terminal are reachable: always on This Mac, while connected for a Host. */
  connected: boolean
  notice?: 'setup' | 'offline'
  check: Recheck
  reconnect?: { busy: boolean; run: () => void }
  /** Where this machine updates: its Settings → Advanced. */
  update?: { label: string; run: () => void }
  /** Opens Settings → Accounts for this machine, where providers sign in. */
  configure?: () => void
}

/** The one status a set of checks adds up to, when nothing else (a connection) decides it. */
function checksHeadline(checks: readonly ReadinessCheck[]): Headline {
  const problems = checks.filter((check) => !check.ok && !check.loading && !check.muted)
  if (checks.some((check) => check.loading))
    return { ok: false, tone: 'pending', label: 'Checking…', short: 'Checking…', detail: '' }
  if (!problems.length) return { ok: true, tone: 'ok', label: 'Ready', short: 'Ready', detail: '' }
  const label =
    problems.length === 1 ? (problems[0]?.short ?? 'Needs attention') : `${problems.length} issues`
  const detail = problems.map((problem) => problem.short).join(' · ')
  return { ok: false, tone: 'warn', label, short: label, detail }
}

function useLive(): React.RefObject<boolean> {
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  return live
}

interface LocalReads extends LocalReadings {
  about?: AboutInfo | null
  busy: boolean
  at: number | null
}

/** This computer's pi, Claude Code (provider, CLI, sign-in) and Tailscale, again on each Check again. */
function useLocalReads(enabled: boolean): LocalReads & { round: number; run: () => void } {
  const [round, setRound] = useState(0)
  const [state, setState] = useState<LocalReads>({ failed: false, busy: false, at: null })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const merge = (patch: Partial<LocalReads>): void => {
      if (live) setState((current) => ({ ...current, ...patch }))
    }
    const failed = (): void => merge({ failed: true })
    void Promise.allSettled([
      window.phosphor.invoke('pi:health').then((health) => merge({ health }), failed),
      readLocalClaude(window.phosphor.invoke).then((claude) => merge({ claude }), failed),
      window.phosphor
        .invoke('hosts:tailscaleStatus')
        .catch((): TailscaleStatus => ({ code: 'check-failed' }))
        .then((tailscale) => merge({ tailscale })),
      window.phosphor.invoke('app:about').then(
        (about) => merge({ about }),
        () => merge({ about: null }),
      ),
    ]).then(() => merge(round ? { busy: false, at: Date.now() } : {}))
    return () => {
      live = false
    }
  }, [enabled, round])
  const run = (): void => {
    setState((current) => ({ ...current, failed: false, busy: true }))
    setRound((n) => n + 1)
  }
  return { ...state, round, run }
}

/** This computer as a machine; null where this client runs no local lanes (the browser). */
export function useLocalOverview(): MachineOverview | null {
  const { localLanes, appInfo } = usePlatform()
  const reads = useLocalReads(localLanes)
  const tasks = useLocalTasks()
  const liveHere = useSessionsStore((s) => localLiveEntries(s.live).length)
  const reachesHosts = useMachinesStore((s) => s.remoteEnabled && s.machines.length > 0)
  const openSettings = useOpenSettings()
  if (!localLanes) return null
  const checks = localChecks(reads, reachesHosts)
  const platform = platformName(window.phosphor.platform)
  const lanes = liveHere ? `${liveHere} live ${liveHere === 1 ? 'lane' : 'lanes'}` : null
  return {
    id: 'local',
    label: localMachineLabel(),
    headline: checksHeadline(checks),
    meta: [
      platform,
      reads.health?.ok ? `pi ${reads.health.version}` : null,
      lanes,
      taskCounts(tasks),
    ].filter((part): part is string => !!part),
    dots: checks,
    tasks,
    about: [platform, 'Your local lanes run here', lanes].filter(Boolean).join(' · '),
    checks,
    note: reads.failed
      ? { text: 'Could not read all local checks. Check again to retry.', alert: true }
      : undefined,
    facts: [
      { label: 'Platform', value: reads.about ? `${platform} ${reads.about.arch}` : platform },
      {
        label: 'Phosphor version',
        value:
          reads.about === undefined ? 'Checking…' : (reads.about?.appVersion ?? 'Not available'),
      },
      {
        label: 'pi',
        value:
          reads.health === undefined ? 'Checking…' : (reads.health?.version ?? 'Not available'),
      },
      { label: 'Live lanes', value: String(liveHere) },
    ],
    connected: true,
    check: { busy: reads.busy, at: reads.at, round: reads.round, run: reads.run },
    update: appInfo
      ? { label: 'Update Phosphor…', run: () => openSettings('local', 'advanced') }
      : undefined,
    configure: () => openSettings('local', 'accounts'),
  }
}

/** A Host's row, from its directory entry and live connection. */
export function hostSummary(
  machine: MachineView,
  connection: HostConnectionView | undefined,
  now: number,
  offset: number,
): MachineSummary {
  const corrected = now + offset
  const headline = machineHeadline(machine, connection, corrected)
  const live = readinessFreshness(machine, now, offset) === 'live'
  // The live Host snapshot says what is running; heartbeat counts are the
  // fallback, and an offline machine's are history.
  const tasks = hostTasks(machine.id, connection)
  const lanes = live ? machine.lanes : null
  const version = connection?.hostVersion || machine.hostVersion
  return {
    id: machine.id,
    label: machine.label,
    machine,
    status: machineStatus(machine, now, offset),
    headline,
    meta: [
      machine.hostname !== machine.label ? machine.hostname : null,
      `${platformName(machine.platform)} ${machine.arch}`,
      version ? `Host ${version}` : null,
      taskCounts(tasks) ??
        (lanes && (lanes.running > 0 || lanes.waiting > 0)
          ? `${lanes.running} running · ${lanes.waiting} waiting`
          : null),
      machine.lastSeenAt && headline.tone !== 'ok'
        ? `last seen ${relativeTime(machine.lastSeenAt, corrected)}`
        : null,
    ].filter((part): part is string => !!part),
    dots: live ? readinessChecks(machine.readiness, machine.endpoint) : null,
    tasks,
  }
}

/**
 * The Host's live Claude detail. `loading` is true while a read for this Host
 * is in flight; `check` stays null when the Host is older or unreachable.
 */
export function useClaudeReadiness(
  hostId: string,
  refresh: number,
): { check: ReadinessCheck | null; loading: boolean } {
  const connection = useRemoteLanesStore((s) => s.hosts[hostId])
  const { detail, loading } = useHostClaude(
    hostId,
    `${connection?.connectionToken}:${refresh}`,
    connection?.state === 'ready',
  )
  const configurable = connection?.configurationSupported === true
  return { check: !loading && detail ? claudeReadiness(detail, configurable) : null, loading }
}

/** Check again reloads the directory, then the Host's own reads follow `round`. */
function useHostRecheck(): Recheck {
  const live = useLive()
  const [state, setState] = useState({ busy: false, at: null as number | null, round: 0 })
  const run = (): void => {
    setState((current) => ({ ...current, busy: true }))
    void useMachinesStore
      .getState()
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        if (live.current) setState((c) => ({ busy: false, at: Date.now(), round: c.round + 1 }))
      })
  }
  return { ...state, run }
}

function useReconnect(hostId: string): { busy: boolean; run: () => void } {
  const live = useLive()
  const [busy, setBusy] = useState(false)
  const run = (): void => {
    setBusy(true)
    void window.phosphor
      .invoke('hosts:reconnect', hostId)
      // The connection status says what happened.
      .catch(() => undefined)
      .finally(() => {
        if (live.current) setBusy(false)
      })
  }
  return { busy, run }
}

/** An enrolled Host as a machine: its heartbeat report, live connection and Claude detail. */
export function useHostOverview(
  machine: MachineView,
  now: number,
  offset: number,
): MachineOverview {
  const connection = useRemoteLanesStore((s) => s.hosts[machine.id])
  const check = useHostRecheck()
  const reconnect = useReconnect(machine.id)
  const claude = useClaudeReadiness(machine.id, check.round)
  const pi = useHostPiVersion(machine.id, check.round)
  const openSettings = useOpenSettings()
  const summary = hostSummary(machine, connection, now, offset)
  const { headline } = summary
  const corrected = now + offset
  const freshness = readinessFreshness(machine, now, offset)
  const version = connection?.hostVersion || machine.hostVersion
  const seen = machine.lastSeenAt && relativeTime(machine.lastSeenAt, corrected)
  const configurable = connection?.configurationSupported === true
  const reported = readinessChecks(machine.readiness, machine.endpoint, configurable).map(
    (check) => {
      // An offline machine's last report is history: shown, but not a list of fixes.
      if (freshness === 'stale') return { ...check, muted: !check.ok }
      if (check.name !== 'Claude Code') return check
      if (claude.loading) return { ...check, loading: true }
      return claude.check ?? check
    },
  )
  const connectionCheck: ReadinessCheck = {
    name: 'Connection',
    ok: headline.ok,
    // Waiting and connecting are progress, not failures: the setup panel holds the one command.
    loading: headline.tone === 'pending',
    loadingText: headline.label,
    short: headline.label,
    detail: headline.detail,
    command: headline.command,
  }
  return {
    ...summary,
    about: `${platformName(machine.platform)} ${machine.arch}${version ? ` · Host ${version}` : ''}`,
    history:
      (machine.hostname !== machine.label ? ` · ${machine.hostname}` : '') +
      (seen ? ` · Last heartbeat ${seen}` : ' · No heartbeat yet'),
    checks: [connectionCheck, ...(freshness === 'none' ? [] : reported)],
    note:
      freshness === 'none'
        ? { text: `${machine.label} reports pi, Claude and Tailscale once it first connects.` }
        : freshness === 'stale' && seen
          ? { text: `As last reported, ${seen}. It may have changed since.` }
          : undefined,
    // The report rides each heartbeat; Check again's "checked" is when this computer last asked.
    reported: seen ? `Reported ${seen}` : 'Not reported yet',
    facts: [
      { label: 'Hostname', value: machine.hostname },
      { label: 'Platform', value: `${platformName(machine.platform)} ${machine.arch}` },
      { label: 'Host version', value: version ?? 'Not reported' },
      ...(pi === null ? [] : [{ label: 'pi', value: pi }]),
      { label: 'Enrolled', value: new Date(machine.enrolledAt).toLocaleDateString() },
      { label: 'Address', value: machine.endpoint ?? 'Not published' },
      { label: 'Fingerprint', value: machine.keyFingerprint, copy: true },
      { label: 'Machine id', value: machine.id, copy: true },
    ],
    connected: !!connection,
    notice: !machine.lastSeenAt
      ? 'setup'
      : summary.status === 'down' && corrected - Date.parse(machine.lastSeenAt) > DAY_MS
        ? 'offline'
        : undefined,
    check,
    reconnect: machine.endpoint ? reconnect : undefined,
    update: machine.endpoint
      ? { label: 'Update Host…', run: () => openSettings(machine.id, 'advanced') }
      : undefined,
    configure: connection?.configurationSupported
      ? () => openSettings(machine.id, 'accounts')
      : undefined,
  }
}
