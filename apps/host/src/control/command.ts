import { randomBytes } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { acquireIdentityLock, LockBusy, type LockPorts } from './lock'
import {
  DEFAULT_CONTROL_URL,
  isControlTrace,
  type HostSelfResponse,
} from '@phosphor/shared/control-api'
import { HOST_VERSION } from '../version'
import { EXIT } from '../checks'
import { loadHostConfig } from '../config/load'
import { createControlClient, ControlFailure, type ClientPorts, type ControlClient } from './client'
import {
  createIdentityStore,
  identityDirectory,
  IdentityFailure,
  type HostIdentity,
  type IdentityStore,
} from './identity'

export interface ControlContext extends ClientPorts {
  configPath: string
  uid: number | undefined
  hostname: string
  platform: NodeJS.Platform
  arch?: string
  print: (line: string) => void
  store?: IdentityStore
  lockPorts?: LockPorts
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}
export interface CommandResult {
  exitCode: number
  message: string
}
interface PreparedControl {
  store: IdentityStore
  client: ControlClient
  url: string
  loaded: Awaited<ReturnType<IdentityStore['load']>>
}

export function commandStore(context: ControlContext): IdentityStore {
  return context.store ?? createIdentityStore(identityDirectory(context.configPath), context.uid)
}

export async function prepareControl(
  context: ControlContext,
  recoverIncomplete = false,
): Promise<PreparedControl> {
  const config = await loadHostConfig(context.configPath, context.uid)
  if (!config.ok) throw new IdentityFailure('Config is not usable. Run phosphor setup to check it.')
  const url = config.config.control?.url ?? DEFAULT_CONTROL_URL
  const store = commandStore(context)
  let loaded: PreparedControl['loaded'] = null
  let identity: HostIdentity | null
  let incomplete: IdentityFailure | undefined
  try {
    loaded = await store.load()
    identity = loaded?.identity ?? null
  } catch (error) {
    if (!(error instanceof IdentityFailure) || !error.incomplete) throw error
    identity = error.incomplete
    incomplete = error
  }
  if (identity && new URL(identity.controlUrl).origin !== new URL(url).origin) {
    throw new IdentityFailure(
      `This machine is signed in to ${new URL(identity.controlUrl).origin}, but the config points at ${new URL(url).origin}. Run phosphor logout --local, then phosphor setup.`,
    )
  }
  if (incomplete && !recoverIncomplete) throw incomplete
  return { store, client: createControlClient(url, context), url, loaded }
}

async function commandLock(context: ControlContext) {
  return acquireIdentityLock(identityDirectory(context.configPath), context.uid, context.lockPorts)
}

export async function withCommandLock<T>(
  context: ControlContext,
  run: () => Promise<T>,
): Promise<T> {
  const release = await commandLock(context)
  try {
    return await run()
  } finally {
    await release()
  }
}

export function controlResult(error: unknown, signal?: AbortSignal): CommandResult {
  if (signal?.aborted) return { exitCode: 130, message: 'Cancelled.' }
  if (error instanceof LockBusy) return { exitCode: EXIT.tempfail, message: error.message }
  if (error instanceof IdentityFailure) return { exitCode: EXIT.config, message: error.message }
  if (error instanceof ControlFailure)
    return {
      exitCode: error.code === 'gone' ? EXIT.noperm : EXIT.tempfail,
      message: error.code === 'gone' ? 'This machine was removed from the account.' : error.message,
    }
  return { exitCode: EXIT.internal, message: 'The command could not finish.' }
}

export function confirmedLine(server: Pick<HostSelfResponse, 'label' | 'owner'>): string {
  const owner = server.owner.login === null ? 'your account' : `@${server.owner.login}'s account`
  return `This machine is now ${JSON.stringify(server.label)} on ${owner}.`
}

export function waitForPoll(context: ControlContext, ms: number): Promise<void> {
  return context.wait
    ? context.wait(ms, context.signal)
    : setTimeout(ms, undefined, { signal: context.signal })
}

/** One trace per command; nested service status calls keep their caller's trace. */
export async function traceCommand<T extends { exitCode: number } | number>(
  context: ControlContext,
  command: string,
  run: (context: ControlContext) => Promise<T>,
): Promise<T> {
  const traced = {
    ...context,
    trace: isControlTrace(context.trace) ? context.trace : randomBytes(8).toString('hex'),
  }
  traced.log?.('host', 'start', { command, trace: traced.trace, hostVersion: HOST_VERSION })
  try {
    const result = await run(traced)
    traced.log?.('host', 'end', {
      command,
      trace: traced.trace,
      exitCode: typeof result === 'number' ? result : result.exitCode,
    })
    return result
  } catch (error) {
    traced.log?.('host', 'end', { command, trace: traced.trace, exitCode: EXIT.internal })
    throw error
  }
}
