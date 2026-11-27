import type { ProbeSlot } from './probe-queue'
import { settingsFile, HOST_FILE_POLICY } from '@phosphor/session-runtime/pi/settings-file'
import { join } from 'node:path'
import { checkProviders } from '../machine/providers'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { inspectClaude } from '../machine/claude'
import { spawn, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'
import { JsonlDecoder } from '@phosphor/session-runtime/pi/jsonl'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { machineRecord, parseMachineProviders } from '@phosphor/shared/host-protocol-machine'
import { inspectHost } from '../commands/doctor'
import { defaultConfigPath } from '../config/load'
import type { HostInspection } from '../commands/doctor'
import type { ClaudeUsageSnapshotResult } from '@phosphor/shared/models'
import type { FeatureContext, FeatureOutcome } from './feature'

import { FeatureFailure, withinProbe } from './failure'
export { FeatureFailure, featureError } from './failure'

/** Trusted wiring may supply the run command's config path. It is never a call parameter. */
export type CataloguePi = NonNullable<HostInspection['pi']>
export interface MachinePorts {
  pi?: CataloguePi
  generation?: () => number
  inspect?: () => Promise<HostInspection>
  configPath?: string
  claudeAuthentication?: () => Promise<boolean | null>
  /** Plan usage of the account a lane bills (`providers/lane-usage.ts`). */
  claudeUsage?: (laneId: string | undefined, force: boolean) => Promise<ClaudeUsageSnapshotResult>
}
/** Inspection reads files that can stall; callers queue behind it, so it must settle. */
export const INSPECTION_DEADLINE_MS = 20_000
export function featureInspection(
  context: FeatureContext,
  ports: MachinePorts,
): Promise<HostInspection> {
  return withinProbe(
    () => startInspection(context, ports),
    performance.now() + INSPECTION_DEADLINE_MS,
    'inspection',
  )
}
function startInspection(context: FeatureContext, ports: MachinePorts): Promise<HostInspection> {
  return ports.inspect
    ? ports.inspect()
    : inspectHost({
        configPath: ports.configPath ?? defaultConfigPath(context.env, context.home),
        env: context.env,
        home: context.home,
        hostname: hostname(),
        platform: process.platform,
        uid: process.getuid?.(),
        nodeVersion: process.version,
        defaultResourceRoot: import.meta.dirname,
      })
}
/** After stdin closes, and again after SIGTERM, how long pi gets before the next signal. */
const QUERY_STOP_GRACE_MS = 2_000
/**
 * End a query's pi so it can release what it holds. pi takes `auth.json.lock` to
 * refresh an expired OAuth token at startup and still holds it when it answers.
 * A SIGKILL leaves that lock for pi's 30s stale window, and the next query (models
 * right after commands) waits on it past its own deadline. Closing stdin is pi's
 * orderly shutdown and SIGTERM still runs its exit hooks; SIGKILL is the last
 * resort. Once pi is gone, whatever is left of its group is killed.
 */
function stopQuery(child: ChildProcess, answered: boolean): void {
  const pid = child.pid
  if (pid === undefined) return
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      /* Already exited. */
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return group('SIGKILL')
  const steps: NodeJS.Signals[] = answered ? ['SIGTERM', 'SIGKILL'] : ['SIGKILL']
  let timer: NodeJS.Timeout | undefined
  const escalate = () => {
    const signal = steps.shift()
    if (!signal) return
    timer = setTimeout(() => {
      group(signal)
      escalate()
    }, QUERY_STOP_GRACE_MS)
  }
  child.once('exit', () => {
    clearTimeout(timer)
    group('SIGKILL')
  })
  child.stdin?.end()
  if (!answered) group('SIGTERM')
  escalate()
}
/** One bounded, session-less query. No tools, prompts or caller-selected command can run. */
export function queryMachine(
  pi: NonNullable<HostInspection['pi']>,
  cwd: string,
  type: 'get_available_models' | 'get_commands',
  // Command discovery loads project extensions and skills; allow a slow cold start.
  timeoutMs = type === 'get_commands' ? 23_000 : 15_000,
  slot?: ProbeSlot,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const budget = slot?.budget(timeoutMs) ?? timeoutMs
    const child = startQuery(pi, cwd)
    // No pid means spawn failed: there is no live child to hold the slot for.
    if (child.pid !== undefined)
      slot?.holdUntil(new Promise<void>((done) => child.once('exit', () => done())))
    const decoder = new JsonlDecoder()
    let bytes = 0
    let settled = false
    let started = false
    const phase = () => (started ? ('pi reply' as const) : ('pi startup' as const))
    const abort = () => finish(new FeatureFailure('internal', 'cancelled', phase()))
    const finish = (error?: FeatureFailure, data?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      slot?.signal?.removeEventListener('abort', abort)
      // Keep reading stdout so pi never blocks on a full pipe while it shuts down.
      stopQuery(child, !error)
      if (error) reject(error)
      else resolve(data)
    }
    const timer = setTimeout(
      () => finish(new FeatureFailure('internal', 'timeout', phase(), budget)),
      budget,
    )
    const exited = () => finish(new FeatureFailure('internal', 'exited', phase()))
    child.once('spawn', () => {
      started = true
    })
    child.on('error', () => finish(new FeatureFailure('internal', 'spawn', 'pi startup')))
    child.on('close', exited)
    // EPIPE can precede the child's spawn error; the child event decides the cause.
    child.stdin.on('error', () => {
      if (started) exited()
    })
    slot?.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) return finish(new FeatureFailure('too-large'))
      for (const line of decoder.push(chunk)) {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          return finish(new FeatureFailure('internal', 'decode', 'pi reply'))
        }
        if (!machineRecord(value) || value.type !== 'response' || value.id !== 'feature') continue
        if (value.success !== true || !machineRecord(value.data))
          return finish(new FeatureFailure('internal', 'decode', 'pi reply'))
        finish(undefined, type === 'get_commands' ? value.data.commands : value.data.models)
        break
      }
    })
    child.stdin.write(JSON.stringify({ id: 'feature', type }) + '\n')
  })
}
function startQuery(pi: CataloguePi, cwd: string) {
  try {
    return spawn(pi.launch.binaryPath, [...pi.launch.prefixArgs, '--mode', 'rpc', '--no-session'], {
      cwd,
      env: pi.environment.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
    })
  } catch {
    throw new FeatureFailure('internal', 'spawn', 'pi startup')
  }
}
export async function machineCall(
  method: string,
  context: FeatureContext,
  ports: MachinePorts,
  params: { laneId?: string; force?: boolean; repositoryId?: string } = {},
): Promise<FeatureOutcome> {
  if (method === 'machine.claudeUsage') {
    if (!ports.claudeUsage) throw new FeatureFailure('unsupported')
    const lane = params.laneId ? context.store.getLane(params.laneId) : null
    if (params.laneId && (!lane || lane.removedAt !== null))
      throw new FeatureFailure('unknown-lane')
    return { ok: true, data: await ports.claudeUsage(params.laneId, params.force === true) }
  }
  const inspection = ports.pi ? null : await featureInspection(context, ports)
  const pi = ports.pi ?? inspection?.pi
  if (!pi) throw new FeatureFailure('internal', 'missing-pi', 'inspection')
  if (method === 'machine.claude') {
    const data = await inspectClaude(
      await listPackages(undefined, piAgentDir(pi.environment.env, context.home)),
      pi.environment,
    )
    if (data.cli === 'ok' && ports.claudeAuthentication) {
      const ready = await ports.claudeAuthentication()
      data.auth = ready === null ? 'unknown' : ready ? 'ok' : 'signed-out'
    }
    return { ok: true, data }
  }
  if (method === 'machine.providers') {
    // Only names and readiness. Reasons can carry arbitrary provider output or credentials.
    const providers = parseMachineProviders(
      inspection ? inspection.report.providers : await currentProviders(pi, context.home),
    )
    if (!providers) throw new FeatureFailure('internal', 'decode', 'inspection')
    const claudeReady = ports.claudeAuthentication ? await ports.claudeAuthentication() : undefined
    const configuredClaude = ports.claudeAuthentication
      ? await inspectClaude(
          await listPackages(undefined, piAgentDir(pi.environment.env, context.home)),
          pi.environment,
        )
      : undefined
    providers.push({
      id: 'pi-claude-cli',
      name: 'Claude CLI',
      status: (
        claudeReady === undefined
          ? inspection?.report.lanes.claude.available
          : claudeReady === true &&
            configuredClaude?.provider === 'ok' &&
            configuredClaude.cli === 'ok'
      )
        ? 'ready'
        : 'not_ready',
    })
    return { ok: true, data: { providers } }
  }
  throw new FeatureFailure('unsupported')
}

async function currentProviders(pi: CataloguePi, home: string) {
  let defaultProvider: string | undefined
  let configuredProviders: string[] = []
  const dir = piAgentDir(pi.environment.env, home)
  try {
    const value = settingsFile(join(dir, 'settings.json'), HOST_FILE_POLICY).raw.defaultProvider
    if (typeof value === 'string') defaultProvider = value
  } catch {
    /* No readable default. */
  }
  try {
    const value = settingsFile(join(dir, 'models.json'), HOST_FILE_POLICY).raw.providers
    if (machineRecord(value)) configuredProviders = Object.keys(value)
  } catch {
    /* No custom provider definitions. */
  }
  return checkProviders(pi.launch, pi.environment, { defaultProvider, configuredProviders })
}
