import { machineStatus, type MachineView } from '@shared/control-api'
import { errorText } from '@shared/errors'
import type { HostCapability } from '@shared/remote-host'
import type { DesktopControlErrorCode, HostsSnapshot, PhosphorApi } from '@shared/ipc'
import { controlMessage } from './controlMessages'
import { machineCounts, type MachineCount } from './machineCounts'
import { machineHeadline, type Tone } from './machineReachability'
import type { MachineClaude } from '@shared/host-protocol-machine'
import {
  claudeReadiness,
  piUnavailable,
  readLocalClaude,
  relativeTime,
  TAILSCALE_FIXES,
  TAILSCALE_OPTIONAL,
  TAILSCALE_READY,
} from './machinePresentation'

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

export interface HealthContext {
  invoke: PhosphorApi['invoke']
  localLabel: string
  signedIn: boolean
  /** Re-reads the machine directory; resolves to an error code, or null. */
  refreshDirectory: () => Promise<DesktopControlErrorCode | null>
  /** Latest directory and connections, read after the refresh. */
  machines: () => readonly MachineView[]
  hosts: () => HostsSnapshot | Promise<HostsSnapshot>
  /** This computer's subscription sign-ins, read now. */
  localProviders: () => Promise<readonly { status: string }[]>
  /** This computer's live lanes and recent folders. */
  localLanes: () => { live: number; folders: number }
  /** Clock-corrected now. */
  now: () => number
  clock?: () => number
  onUpdate: (run: HealthRun) => void
}

interface Probe {
  id: string
  label: string
  /** What a Host must grant this computer first; This Mac's run reads every probe. */
  capability?: HostCapability
  run: () => Promise<{ tone: Tone; detail: string }>
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One machine's reads behind the probes every machine runs. */
interface MachineReads {
  providers: () => Promise<readonly { status: string }[]>
  models: () => Promise<number>
  /** null: a Host too old to report it. */
  claude: () => Promise<MachineClaude | null>
  lanes: () => Promise<string>
}
/** What a Host must grant this computer before each read; the counts carry their own. */
const HOST_GRANTS: Record<string, HostCapability> = {
  providers: 'skills.read',
  models: 'skills.read',
  claude: 'skills.read',
  lanes: 'sessions.read',
}
/** The machine counts the health check runs, by the noun each step counts. */
const COUNTED: Partial<Record<MachineCount['key'], string>> = {
  skills: 'skill',
  routines: 'routine',
}

/** Providers, Models, Claude Code, Skills, Routines and Lanes, for This Mac or a Host. */
function machineProbes(
  reads: MachineReads,
  counts: readonly MachineCount[],
  grants: Record<string, HostCapability> = {},
): Probe[] {
  const probes: Probe[] = [
    {
      id: 'providers',
      label: 'Providers',
      run: async () => {
        const providers = await reads.providers()
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
      run: async () => {
        const models = await reads.models()
        return models
          ? { tone: 'ok', detail: plural(models, 'model') }
          : { tone: 'warn', detail: 'No usable models' }
      },
    },
    {
      id: 'claude',
      label: 'Claude Code',
      run: async () => {
        const detail = await reads.claude()
        if (!detail) return { tone: 'off', detail: 'Not reported by this Host version' }
        const check = claudeReadiness(detail)
        return { tone: check.ok ? 'ok' : 'warn', detail: check.ok ? 'Ready' : check.short }
      },
    },
    ...counts.flatMap(({ key, label, capability, read }) => {
      const noun = COUNTED[key]
      if (!noun) return []
      return [
        {
          id: key,
          label,
          capability,
          run: async () => ({ tone: 'ok' as const, detail: plural(await read(), noun) }),
        },
      ]
    }),
    { id: 'lanes', label: 'Lanes', run: async () => ({ tone: 'ok', detail: await reads.lanes() }) },
  ]
  return probes.map((probe) => ({ ...probe, capability: probe.capability ?? grants[probe.id] }))
}

/** A step that does not run: already settled, as a skipped or ungranted read. */
type Planned = Probe | HealthStep

/** This Mac's steps: the control plane, Tailscale and pi, then every machine's probes. */
function localProbes(context: HealthContext): Probe[] {
  const { invoke } = context
  const reads: MachineReads = {
    providers: context.localProviders,
    models: async () => (await invoke('pi:catalogueModels')).models.length,
    claude: () => readLocalClaude(invoke),
    lanes: async () => {
      const { live, folders } = context.localLanes()
      return `${plural(live, 'live lane')} · ${plural(folders, 'folder')}`
    },
  }
  return [
    {
      id: 'control',
      label: 'Control plane',
      run: async () => {
        if (!context.signedIn) return { tone: 'off', detail: 'Signed out' }
        const error = await context.refreshDirectory()
        return error
          ? { tone: 'error', detail: controlMessage(error) }
          : { tone: 'ok', detail: plural(context.machines().length, 'machine') }
      },
    },
    {
      id: 'tailscale',
      label: 'Tailscale',
      // As This Mac's readiness row: without Hosts to reach, it is optional.
      run: async () => {
        const status = await invoke('hosts:tailscaleStatus')
        if (status.code === 'ready') return { tone: 'ok', detail: TAILSCALE_READY }
        return context.signedIn && context.machines().length
          ? { tone: 'warn', detail: TAILSCALE_FIXES[status.code] }
          : { tone: 'off', detail: TAILSCALE_OPTIONAL }
      },
    },
    {
      id: 'pi',
      label: 'pi',
      run: async () => {
        const health = await invoke('pi:health')
        return health.ok
          ? { tone: 'ok', detail: `pi ${health.version}` }
          : { tone: 'error', detail: piUnavailable(health) }
      },
    },
    ...machineProbes(reads, machineCounts(invoke, 'local')),
  ]
}

/** A Host's steps: its heartbeat and connection, then the probes it is connected and granted for. */
function hostProbes(
  context: HealthContext,
  machine: MachineView,
  view: HostsSnapshot[string] | undefined,
): Planned[] {
  const now = context.now()
  const headline = machineHeadline(machine, view, now)
  const probes = machineProbes(
    {
      providers: () => context.invoke('hosts:providers', machine.id),
      models: async () => (await context.invoke('hosts:models', machine.id)).length,
      claude: () => context.invoke('hosts:claude', machine.id),
      lanes: async () =>
        `${plural(view?.lanes.length ?? 0, 'lane')} · ${plural(view?.repositories.length ?? 0, 'folder')}`,
    },
    machineCounts(context.invoke, machine.id),
    HOST_GRANTS,
  )
  const granted = (capability?: HostCapability) =>
    !capability || !!view?.capabilities.includes(capability)
  return [
    {
      id: 'heartbeat',
      label: 'Heartbeat',
      run: async () => {
        if (!machine.lastSeenAt) return { tone: 'pending', detail: 'Never checked in' }
        const seen = relativeTime(machine.lastSeenAt, now)
        return machineStatus(machine, now) === 'up'
          ? { tone: 'ok', detail: `Checked in ${seen}` }
          : { tone: 'off', detail: `Last check-in ${seen}` }
      },
    },
    {
      id: 'connection',
      label: 'Connection',
      run: async () => ({
        tone: headline.tone,
        detail: view?.hostVersion ? `${headline.label} · Host ${view.hostVersion}` : headline.label,
      }),
    },
    // One line, not one per read: none of them can run without a connection.
    ...(view?.state !== 'ready'
      ? [
          {
            id: 'reads',
            label: 'Host reads',
            tone: 'off' as const,
            detail: `Skipped until connected: ${probes.map((p) => p.label).join(', ')}`,
          },
        ]
      : probes.map((probe) =>
          granted(probe.capability)
            ? probe
            : {
                id: probe.id,
                label: probe.label,
                tone: 'off' as const,
                detail: 'Not granted to this computer',
              },
        )),
  ]
}

export async function runHealthCheck(context: HealthContext): Promise<HealthRun> {
  const clock = context.clock ?? (() => performance.now())
  const run: HealthRun = { startedAt: Date.now(), targets: [] }
  const publish = () => context.onUpdate(structuredClone(run))
  async function step(target: HealthTarget, probe: Probe): Promise<void> {
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
  }
  async function check(id: string, label: string, steps: readonly Planned[]): Promise<void> {
    const target: HealthTarget = { id, label, steps: [] }
    run.targets.push(target)
    for (const planned of steps)
      if ('run' in planned) await step(target, planned)
      else target.steps.push(planned)
    publish()
  }

  await check('local', context.localLabel, localProbes(context))
  if (context.signedIn) {
    const hosts = await context.hosts()
    await Promise.all(
      context
        .machines()
        .map((machine) =>
          check(machine.id, machine.label, hostProbes(context, machine, hosts[machine.id])),
        ),
    )
  }
  run.finishedAt = Date.now()
  publish()
  return run
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
