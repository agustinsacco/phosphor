import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { inspectClaude } from '../machine/claude'
import { spawn, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'
import { JsonlDecoder } from '@phosphor/session-runtime/pi/jsonl'
import {
  machineRecord,
  parseMachineModels,
  parseMachineProviders,
} from '@phosphor/shared/host-protocol-machine'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import { inspectHost } from '../commands/doctor'
import { defaultConfigPath } from '../config/load'
import type { HostInspection } from '../commands/doctor'
import type { ClaudeUsageSnapshotResult } from '@phosphor/shared/models'
import type { FeatureContext, FeatureOutcome } from './feature'

export class FeatureFailure extends Error {
  constructor(readonly code: CallErrorCode) {
    super(code)
  }
}
export function featureError(error: unknown): FeatureOutcome {
  const code = error instanceof FeatureFailure ? error.code : 'internal'
  const messages: Partial<Record<CallErrorCode, string>> = {
    'bad-request': 'Invalid feature request.',
    'unknown-lane': 'Unknown lane.',
    'too-large': 'Feature result exceeds its limit.',
    internal: 'Feature unavailable.',
  }
  return {
    ok: false,
    error: {
      code,
      message: messages[code] ?? 'Feature unavailable.',
    },
  }
}
/** Trusted wiring may supply the run command's config path. It is never a call parameter. */
export interface MachinePorts {
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
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FeatureFailure('internal')), INSPECTION_DEADLINE_MS)
  })
  return Promise.race([startInspection(context, ports), deadline]).finally(() =>
    clearTimeout(timer),
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
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pi.launch.binaryPath,
      [...pi.launch.prefixArgs, '--mode', 'rpc', '--no-session'],
      {
        cwd,
        env: pi.environment.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      },
    )
    const decoder = new JsonlDecoder()
    let bytes = 0
    let settled = false
    const finish = (error?: FeatureFailure, data?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Keep reading stdout so pi never blocks on a full pipe while it shuts down.
      stopQuery(child, !error)
      if (error) reject(error)
      else resolve(data)
    }
    const timer = setTimeout(() => finish(new FeatureFailure('internal')), 15_000)
    child.on('error', () => finish(new FeatureFailure('internal')))
    child.on('close', () => finish(new FeatureFailure('internal')))
    child.stdin.on('error', () => finish(new FeatureFailure('internal')))
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) return finish(new FeatureFailure('too-large'))
      for (const line of decoder.push(chunk)) {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          return finish(new FeatureFailure('internal'))
        }
        if (!machineRecord(value) || value.type !== 'response' || value.id !== 'feature') continue
        if (value.success !== true || !machineRecord(value.data))
          return finish(new FeatureFailure('internal'))
        finish(undefined, type === 'get_commands' ? value.data.commands : value.data.models)
        break
      }
    })
    child.stdin.write(JSON.stringify({ id: 'feature', type }) + '\n')
  })
}
export async function machineCall(
  method: string,
  context: FeatureContext,
  ports: MachinePorts,
  params: { laneId?: string; force?: boolean } = {},
): Promise<FeatureOutcome> {
  if (method === 'machine.claudeUsage') {
    if (!ports.claudeUsage) throw new FeatureFailure('unsupported')
    const lane = params.laneId ? context.store.getLane(params.laneId) : null
    if (params.laneId && (!lane || lane.removedAt !== null))
      throw new FeatureFailure('unknown-lane')
    return { ok: true, data: await ports.claudeUsage(params.laneId, params.force === true) }
  }
  const inspection = await featureInspection(context, ports)
  if (!inspection.pi) throw new FeatureFailure('internal')
  if (method === 'machine.claude') {
    const data = await inspectClaude(await listPackages(), inspection.pi.environment)
    if (data.cli === 'ok' && ports.claudeAuthentication) {
      const ready = await ports.claudeAuthentication()
      data.auth = ready === null ? 'unknown' : ready ? 'ok' : 'signed-out'
    }
    return { ok: true, data }
  }
  if (method === 'machine.providers') {
    // Only names and readiness. Reasons can carry arbitrary provider output or credentials.
    const providers = parseMachineProviders(inspection.report.providers)
    if (!providers) throw new FeatureFailure('internal')
    const claudeReady = ports.claudeAuthentication ? await ports.claudeAuthentication() : undefined
    const configuredClaude = ports.claudeAuthentication
      ? await inspectClaude(await listPackages(), inspection.pi.environment)
      : undefined
    providers.push({
      id: 'pi-claude-cli',
      name: 'Claude CLI',
      status: (
        claudeReady === undefined
          ? inspection.report.lanes.claude.available
          : claudeReady === true &&
            configuredClaude?.provider === 'ok' &&
            configuredClaude.cli === 'ok'
      )
        ? 'ready'
        : 'not_ready',
    })
    return { ok: true, data: { providers } }
  }
  const raw = await queryMachine(inspection.pi, context.home, 'get_available_models')
  if (Array.isArray(raw) && raw.length > 1000) throw new FeatureFailure('too-large')
  const models = parseMachineModels(raw)
  if (!models) throw new FeatureFailure('internal')
  return { ok: true, data: { models, source: 'pi' } }
}
