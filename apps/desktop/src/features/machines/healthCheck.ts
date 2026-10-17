import { machineStatus, type MachineView } from '@shared/control-api'
import { errorText } from '@shared/errors'
import type { HostCapability } from '@shared/remote-host'
import type { DesktopControlErrorCode, HostsSnapshot, IpcInvokeMap } from '@shared/ipc'
import { claudeReadiness } from './ClaudeReadiness'
import { controlMessage } from './controlMessages'
import { machineHeadline, type Tone } from './machineReachability'
import { relativeTime } from './machinePresentation'
import { TAILSCALE_FIXES } from './onboarding/BeforeYouStart'

/**
 * The Machines health check: every read Desktop makes of the control plane
 * and each Host, run once and timed. It only reads. Reconnecting is a
 * separate, explicit action, because replacing a connection resyncs open lanes.
 */
export type StepTone = Tone | 'running'
export interface HealthStep {
  id: string
  label: string
  tone: StepTone
  detail: string
  ms?: number
}
export interface HealthTarget {
  /** `local`, or a Host id. */
  id: string
  label: string
  steps: HealthStep[]
}
export interface HealthRun {
  startedAt: number
  finishedAt?: number
  targets: HealthTarget[]
}

type Invoke = <C extends keyof IpcInvokeMap>(
  channel: C,
  ...args: IpcInvokeMap[C]['args']
) => Promise<IpcInvokeMap[C]['result']>

export interface HealthContext {
  invoke: Invoke
  localLabel: string
  signedIn: boolean
  /** Re-reads the machine directory; resolves to an error code, or null. */
  refreshDirectory: () => Promise<DesktopControlErrorCode | null>
  /** Latest directory and connections, read after the refresh. */
  machines: () => readonly MachineView[]
  hosts: () => HostsSnapshot | Promise<HostsSnapshot>
  /** Clock-corrected now. */
  now: () => number
  clock?: () => number
  onUpdate: (run: HealthRun) => void
}

interface Probe {
  id: string
  label: string
  capability?: HostCapability
  run: () => Promise<{ tone: Tone; detail: string }>
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export async function runHealthCheck(context: HealthContext): Promise<HealthRun> {
  const clock = context.clock ?? (() => performance.now())
  const run: HealthRun = { startedAt: Date.now(), targets: [] }
  const publish = () => context.onUpdate(structuredClone(run))
  async function step(target: HealthTarget, probe: Probe): Promise<HealthStep> {
    const entry: HealthStep = { id: probe.id, label: probe.label, tone: 'running', detail: '' }
    target.steps.push(entry)
    publish()
    const start = clock()
    try {
      Object.assign(entry, await probe.run())
    } catch (error) {
      Object.assign(entry, { tone: 'error', detail: errorText(error) })
    }
    entry.ms = Math.round(clock() - start)
    publish()
    return entry
  }

  const local: HealthTarget = { id: 'local', label: context.localLabel, steps: [] }
  run.targets.push(local)
  await step(local, {
    id: 'control',
    label: 'Control plane',
    run: async () => {
      if (!context.signedIn) return { tone: 'off', detail: 'Signed out' }
      const error = await context.refreshDirectory()
      return error
        ? { tone: 'error', detail: controlMessage(error) }
        : { tone: 'ok', detail: plural(context.machines().length, 'machine') }
    },
  })
  await step(local, {
    id: 'tailscale',
    label: 'Tailscale',
    run: async () => {
      const status = await context.invoke('hosts:tailscaleStatus')
      return status.code === 'ready'
        ? { tone: 'ok', detail: 'Running with MagicDNS and HTTPS' }
        : { tone: 'warn', detail: TAILSCALE_FIXES[status.code] }
    },
  })
  await step(local, {
    id: 'pi',
    label: 'pi',
    run: async () => {
      const health = await context.invoke('pi:health')
      return health.ok
        ? { tone: 'ok', detail: `pi ${health.version}` }
        : { tone: 'error', detail: health.reason ?? 'pi is not available' }
    },
  })

  if (context.signedIn) {
    const hosts = await context.hosts()
    await Promise.all(
      context.machines().map(async (machine) => {
        const target: HealthTarget = { id: machine.id, label: machine.label, steps: [] }
        run.targets.push(target)
        await checkHost(machine, target, hosts[machine.id])
      }),
    )
  }
  run.finishedAt = Date.now()
  publish()
  return run

  async function checkHost(
    machine: MachineView,
    target: HealthTarget,
    view: HostsSnapshot[string] | undefined,
  ): Promise<void> {
    const now = context.now()
    await step(target, {
      id: 'heartbeat',
      label: 'Heartbeat',
      run: async () => {
        if (!machine.lastSeenAt) return { tone: 'pending', detail: 'Never checked in' }
        const seen = relativeTime(machine.lastSeenAt, now)
        return machineStatus(machine, now) === 'up'
          ? { tone: 'ok', detail: `Checked in ${seen}` }
          : { tone: 'off', detail: `Last check-in ${seen}` }
      },
    })
    const headline = machineHeadline(machine, view, now)
    await step(target, {
      id: 'connection',
      label: 'Connection',
      run: async () => ({
        tone: headline.tone,
        detail: view?.hostVersion ? `${headline.label} · Host ${view.hostVersion}` : headline.label,
      }),
    })
    const ready = view?.state === 'ready'
    const granted = (capability?: HostCapability) =>
      !capability || !!view?.capabilities.includes(capability)
    const probes: Probe[] = [
      {
        id: 'providers',
        label: 'Providers',
        capability: 'skills.read',
        run: async () => {
          const providers = await context.invoke('hosts:providers', machine.id)
          const signed = providers.filter((p) => p.status === 'ready').length
          return {
            tone: signed ? 'ok' : 'warn',
            detail: `${plural(providers.length, 'provider')} · ${signed} signed in`,
          }
        },
      },
      {
        id: 'models',
        label: 'Models',
        capability: 'skills.read',
        run: async () => {
          const models = await context.invoke('hosts:models', machine.id)
          return models.length
            ? { tone: 'ok', detail: plural(models.length, 'model') }
            : { tone: 'warn', detail: 'No usable models' }
        },
      },
      {
        id: 'claude',
        label: 'Claude Code',
        capability: 'skills.read',
        run: async () => {
          const detail = await context.invoke('hosts:claude', machine.id)
          if (!detail) return { tone: 'off', detail: 'Not reported by this Host version' }
          const check = claudeReadiness(detail)
          return { tone: check.ok ? 'ok' : 'warn', detail: check.ok ? 'Ready' : check.short }
        },
      },
      {
        id: 'skills',
        label: 'Skills',
        capability: 'skills.read',
        run: async () => {
          const result = await context.invoke('hosts:skills', machine.id)
          return { tone: 'ok', detail: plural(result.skills.length, 'skill') }
        },
      },
      {
        id: 'routines',
        label: 'Routines',
        capability: 'routines',
        run: async () => {
          const result = await context.invoke('routines:list', `host:${machine.id}`)
          return { tone: 'ok', detail: plural(result.routines.length, 'routine') }
        },
      },
      {
        id: 'lanes',
        label: 'Lanes',
        capability: 'sessions.read',
        run: async () => ({
          tone: 'ok',
          detail: `${plural(view?.lanes.length ?? 0, 'lane')} · ${plural(view?.repositories.length ?? 0, 'folder')}`,
        }),
      },
    ]
    // One line, not one per read: none of them can run without a connection.
    if (!ready)
      target.steps.push({
        id: 'reads',
        label: 'Host reads',
        tone: 'off',
        detail: `Skipped until connected: ${probes.map((p) => p.label).join(', ')}`,
      })
    for (const probe of ready ? probes : []) {
      if (!granted(probe.capability)) {
        target.steps.push({
          id: probe.id,
          label: probe.label,
          tone: 'off',
          detail: 'Not granted to this computer',
        })
        continue
      }
      await step(target, probe)
    }
    publish()
  }
}

export type Summary = { tone: StepTone; label: string; issues: number }
/** A run's findings count toward the badge for this long, then only live state does. */
export const RUN_FRESH_MS = 10 * 60_000

/** What the status badge says: live directory state plus a recent run's findings. */
export function healthSummary(input: {
  running: boolean
  controlError: boolean
  signedIn: boolean
  machines: readonly MachineView[]
  hosts: HostsSnapshot
  /** Clock-corrected now, for heartbeats. */
  now: number
  run: HealthRun | null
  wallNow?: number
}): Summary {
  if (input.running) return { tone: 'running', label: 'Checking…', issues: 0 }
  if (input.signedIn && input.controlError)
    return { tone: 'error', label: 'Control unreachable', issues: 1 }
  const failing = new Set<string>()
  let offline = 0,
    connecting = 0,
    setup = 0
  if (input.signedIn)
    for (const machine of input.machines) {
      const headline = machineHeadline(machine, input.hosts[machine.id], input.now)
      if (headline.tone === 'warn' || headline.tone === 'error') failing.add(machine.id)
      else if (headline.tone === 'off') offline++
      else if (headline.label === 'Waiting for setup') setup++
      else if (headline.tone === 'pending') connecting++
    }
  const run = input.run
  if (run?.finishedAt && (input.wallNow ?? Date.now()) - run.finishedAt < RUN_FRESH_MS)
    for (const target of run.targets)
      if (target.steps.some((s) => s.tone === 'warn' || s.tone === 'error')) failing.add(target.id)
  const issues = failing.size
  if (issues) return { tone: 'warn', label: issues === 1 ? '1 issue' : `${issues} issues`, issues }
  if (offline) return { tone: 'off', label: `${offline} offline`, issues: 0 }
  if (connecting) return { tone: 'pending', label: 'Connecting…', issues: 0 }
  if (setup) return { tone: 'pending', label: 'Waiting for setup', issues: 0 }
  return { tone: 'ok', label: 'All systems normal', issues: 0 }
}
