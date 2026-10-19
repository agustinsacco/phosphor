import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { claudeUsageReader, inspectClaude, type ClaudeUsageRead } from '../machine/claude'
import { spawn } from 'node:child_process'
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
  claudeUsage?: ClaudeUsageRead
}
const hostClaudeUsage = claudeUsageReader()
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
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
      child.stdout.destroy()
      child.stdin.destroy()
      if (error) reject(error)
      else resolve(data)
    }
    const timer = setTimeout(() => finish(new FeatureFailure('internal')), 15_000)
    child.on('error', () => finish(new FeatureFailure('internal')))
    child.on('close', () => finish(new FeatureFailure('internal')))
    child.stdin.on('error', () => finish(new FeatureFailure('internal')))
    child.stdout.on('data', (chunk: Buffer) => {
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
  params: { force?: boolean } = {},
): Promise<FeatureOutcome> {
  const inspection = await featureInspection(context, ports)
  if (!inspection.pi) throw new FeatureFailure('internal')
  if (method === 'machine.claudeUsage') {
    const read = ports.claudeUsage ?? hostClaudeUsage
    return { ok: true, data: await read(inspection.pi.environment, { force: params.force }) }
  }
  if (method === 'machine.claude') {
    return { ok: true, data: await inspectClaude(await listPackages(), inspection.pi.environment) }
  }
  if (method === 'machine.providers') {
    // Only names and readiness. Reasons can carry arbitrary provider output or credentials.
    const providers = parseMachineProviders(inspection.report.providers)
    if (!providers) throw new FeatureFailure('internal')
    providers.push({
      id: 'pi-claude-cli',
      name: 'Claude CLI',
      status: inspection.report.lanes.claude.available ? 'ready' : 'not_ready',
    })
    return { ok: true, data: { providers } }
  }
  const raw = await queryMachine(inspection.pi, context.home, 'get_available_models')
  if (Array.isArray(raw) && raw.length > 1000) throw new FeatureFailure('too-large')
  const models = parseMachineModels(raw)
  if (!models) throw new FeatureFailure('internal')
  return { ok: true, data: { models, source: 'pi' } }
}
