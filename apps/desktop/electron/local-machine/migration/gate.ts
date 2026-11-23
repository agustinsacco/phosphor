import type { LocalMachineStatus, LocalRuntimeMode } from '@phosphor/shared/ipc'
import type { LocalDaemonAccess } from '../mode'
import { rollForward, type CommitOutcome } from './commit'
import { decideLaunch, type LaunchFacts, type LaunchPlan, type LockFact } from './decision'
import { consentMigration, retryMigration, type ActionResult } from './gate-actions'
import {
  journalWriter,
  readJournal,
  withState,
  type JournalRead,
  type JournalWriter,
  type MigrationJournal,
  type MigrationPermit,
} from './journal'
import type { OwnerChannel } from './owner-channel'
import { runMigration, type RunnerPorts, type RunOutcome } from './runner'
import { hasLocalServiceFeatures } from './service-record'

/**
 * The launch gate's core: reads the facts, decides with `decideLaunch`, asks
 * the service when the row needs it (over its own short-lived owner channel,
 * opened time-bounded and closed before the mode is decided), runs or rolls
 * the migration forward, then decides the runtime mode once. Electron-free;
 * `launch-gate.ts` binds it.
 */

export type GateRunnerPorts = Omit<RunnerPorts, 'owner' | 'writer' | 'quit' | 'onStep'>

export interface GatePorts {
  readonly migrationDir: string
  readonly permit: MigrationPermit
  readonly packaged: boolean
  readonly readLock: () => Promise<LockFact>
  readonly legacyKeys: () => boolean
  readonly localRuntime: () => boolean
  readonly recordedFeatures: () => readonly string[] | null
  /** How to reach This Mac's service, or null when this process cannot. */
  readonly access: LocalDaemonAccess | null
  /** Stands in for `access` when daemon mode must show a service it cannot reach. */
  readonly unreachable: LocalDaemonAccess
  readonly e2eDaemon: boolean
  readonly openChannel: (access: LocalDaemonAccess) => Promise<OwnerChannel | null>
  readonly runner: GateRunnerPorts
  readonly decide: (mode: LocalRuntimeMode, access: LocalDaemonAccess) => void
}

/** Bounds a quit's wait for a commit already requested; the next launch rolls it forward. */
export const QUIT_AFTER_COMMIT_MS = 15_000

export const journalOf = (read: JournalRead): MigrationJournal | null =>
  read.kind === 'ok' ? read.journal : null

interface Gate {
  readonly ports: GatePorts
  status: LocalMachineStatus
  readonly listeners: Set<(status: LocalMachineStatus) => void>
  readonly quitting: AbortController
  running: Promise<LocalRuntimeMode> | null
}

function publish(gate: Gate, next: LocalMachineStatus) {
  gate.status = next
  for (const listener of [...gate.listeners]) listener(next)
}

const writer = (gate: Gate): JournalWriter =>
  journalWriter(gate.ports.migrationDir, gate.ports.permit)
const isoNow = (gate: Gate) => new Date(gate.ports.runner.now()).toISOString()

async function facts(ports: GatePorts, read: JournalRead): Promise<LaunchFacts> {
  const journal = journalOf(read)
  return {
    permitted: ports.permit.allowed,
    journal: read,
    lock: await ports.readLock(),
    // A consented journal is the user's choice to move a service Desktop did not install.
    recorded:
      hasLocalServiceFeatures(ports.recordedFeatures() ?? undefined) ||
      journal?.state === 'consented',
    legacyKeys: ports.legacyKeys(),
    localRuntime: ports.localRuntime(),
    reachable: ports.access !== null,
    packaged: ports.packaged,
    e2eDaemon: ports.e2eDaemon,
    attempts: journal?.attempts[ports.runner.desktopVersion] ?? 0,
  }
}

function decide(gate: Gate, mode: LocalRuntimeMode, next: LocalMachineStatus): LocalRuntimeMode {
  publish(gate, { ...next, mode })
  gate.ports.decide(mode, gate.ports.access ?? gate.ports.unreachable)
  return mode
}

const serviceDown = (gate: Gate, migration: LocalMachineStatus['migration']) =>
  decide(gate, 'daemon', { mode: 'daemon', migration, service: 'down' })

function afterCommit(gate: Gate, outcome: CommitOutcome): LocalRuntimeMode {
  const { failure } = outcome.journal
  if (outcome.kind === 'committed')
    return decide(gate, 'daemon', { mode: 'daemon', migration: 'committed' })
  return decide(gate, 'daemon', {
    mode: 'daemon',
    migration: 'failed',
    ...(failure ? { failure } : {}),
  })
}

const runnerPorts = (gate: Gate, owner: OwnerChannel): RunnerPorts => ({
  ...gate.ports.runner,
  owner,
  writer: writer(gate),
  quit: gate.quitting.signal,
  onStep: (step) => publish(gate, { ...gate.status, migration: 'running', step }),
})

/** Past the commit point: roll forward, then daemon mode; never in-app. */
async function resume(gate: Gate, journal: MigrationJournal): Promise<LocalRuntimeMode> {
  const { access, permit, packaged } = gate.ports
  // A build that may not write a journal only shows the service's data; it never replays.
  if (!permit.allowed || !access)
    return decide(gate, 'daemon', {
      mode: 'daemon',
      migration: journal.state === 'committed' ? 'committed' : 'running',
      ...(access ? {} : { service: 'down', ...(packaged ? {} : { notice: 'dev-build' }) }),
    })
  if (journal.state === 'committed')
    return afterCommit(gate, await rollForward(runnerPorts(gate, NO_CHANNEL), null, journal))
  const channel = await gate.ports.openChannel(access)
  if (!channel) return serviceDown(gate, 'running')
  try {
    return afterCommit(gate, await rollForward(runnerPorts(gate, channel), channel, journal))
  } catch {
    return serviceDown(gate, 'running')
  } finally {
    channel.close()
  }
}

/** A previous attempt that never reached its end counts as a failed one. */
function interrupted(gate: Gate, previous: MigrationJournal | null): MigrationJournal | null {
  if (previous?.state !== 'running') return previous
  const version = gate.ports.runner.desktopVersion
  const attempts = { ...previous.attempts, [version]: (previous.attempts[version] ?? 0) + 1 }
  const failure = { step: previous.steps.at(-1)?.step ?? 'preflight', code: 'interrupted' }
  const aborted = withState({ ...previous, attempts }, 'aborted', isoNow(gate), failure)
  writer(gate).write(aborted)
  return aborted
}

function afterRun(gate: Gate, outcome: RunOutcome): LocalRuntimeMode {
  if (outcome.kind !== 'aborted') return afterCommit(gate, outcome)
  const { failure } = outcome.journal
  return decide(gate, 'in-app', {
    mode: 'in-app',
    migration: 'failed',
    ...(failure ? { failure } : {}),
  })
}

async function migrate(gate: Gate, plan: Extract<LaunchPlan, { kind: 'migrate' }>) {
  const previous = interrupted(gate, plan.previous)
  const { access } = gate.ports
  const channel =
    access && !gate.quitting.signal.aborted ? await gate.ports.openChannel(access) : null
  if (!channel) return decide(gate, 'in-app', { mode: 'in-app', migration: 'waiting' })
  try {
    const local = await channel.call('machine.local', undefined)
    const lock = local.ownerLock
    const standby = lock?.standby === true && lock.holder !== 'daemon'
    if (!hasLocalServiceFeatures(local.features) || !standby)
      return decide(gate, 'in-app', {
        mode: 'in-app',
        migration: standby ? 'not-needed' : 'waiting',
      })
    publish(gate, { mode: 'in-app', migration: 'running', step: 'preflight' })
    const outcome = await runMigration(runnerPorts(gate, channel), {
      previous,
      machineId: local.machineId,
    })
    return afterRun(gate, outcome)
  } finally {
    channel.close()
  }
}

async function run(gate: Gate): Promise<LocalRuntimeMode> {
  const { migrationDir } = gate.ports
  const plan = decideLaunch(await facts(gate.ports, readJournal(migrationDir)))
  if (plan.kind === 'in-app') return decide(gate, 'in-app', plan.status)
  if (plan.kind === 'daemon') return decide(gate, 'daemon', plan.status)
  if (plan.kind === 'resume') return resume(gate, plan.journal)
  try {
    return await migrate(gate, plan)
  } catch {
    // Anything unforeseen: in-app is safe only while no commit was asked for.
    const after = journalOf(readJournal(migrationDir))
    if (after && (after.state === 'commit-requested' || after.state === 'committed'))
      return serviceDown(gate, 'running')
    return decide(gate, 'in-app', { mode: 'in-app', migration: 'failed' })
  }
}

/**
 * A quit while the gate runs: before `commit-requested` the attempt aborts;
 * after it the commit finishes, bounded, or rolls forward next launch.
 */
function quit(gate: Gate): Promise<void> {
  gate.quitting.abort('quit')
  const { running } = gate
  if (!running) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, QUIT_AFTER_COMMIT_MS)
    timer.unref?.()
  })
  const settled = running.then(
    () => undefined,
    () => undefined,
  )
  return Promise.race([settled, bound]).finally(() => clearTimeout(timer))
}

export function createLaunchGate(ports: GatePorts) {
  const gate: Gate = {
    ports,
    status: { mode: 'in-app', migration: 'not-needed' },
    listeners: new Set(),
    quitting: new AbortController(),
    running: null,
  }
  const actionPorts = {
    ...ports,
    writer: () => writer(gate),
    published: (next: LocalMachineStatus['migration']) =>
      publish(gate, { ...gate.status, migration: next }),
  }
  return {
    status: (): LocalMachineStatus => gate.status,
    onStatus(listener: (status: LocalMachineStatus) => void): () => void {
      gate.listeners.add(listener)
      return () => gate.listeners.delete(listener)
    },
    run(): Promise<LocalRuntimeMode> {
      gate.running ??= run(gate)
      return gate.running
    },
    retry: (): Promise<ActionResult> => retryMigration(actionPorts),
    consent: (): Promise<ActionResult> => consentMigration(actionPorts),
    quit: () => quit(gate),
  }
}

export type LaunchGate = ReturnType<typeof createLaunchGate>

/** No service is needed once the journal reads `committed`; any call is a bug. */
const NO_CHANNEL: OwnerChannel = {
  machineId: '',
  call: () => Promise.reject(new Error('No owner channel after the commit.')),
  close: () => {},
}
