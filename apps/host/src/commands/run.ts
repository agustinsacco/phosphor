import { randomInt } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import {
  controlResult,
  prepareControl,
  withCommandLock,
  type ControlContext,
} from '../control/command'
import { createHeartbeat, createSequenceStore, type HeartbeatPorts } from '../control/heartbeat'
import { identityDirectory, IdentityFailure } from '../control/identity'
import { acquireIdentityLock } from '../control/lock'
import { loadHostConfig } from '../config/load'
import { checkReadiness } from '../machine/readiness'
import type { Drainable } from '../shutdown'
import { HOST_VERSION } from '../version'

export interface RunContext extends ControlContext {
  env: NodeJS.ProcessEnv
  attach?: (target: Drainable) => () => void
  heartbeat?: Partial<Pick<HeartbeatPorts, 'readiness' | 'seq' | 'random'>>
}
export async function runHost(context: RunContext): Promise<number> {
  let release: (() => Promise<void>) | undefined
  let detach: (() => void) | undefined
  try {
    const prepared = await withCommandLock(context, () => prepareControl(context))
    if (!prepared.loaded) {
      context.print('Run phosphor login first.')
      return 69
    }
    const directory = identityDirectory(context.configPath)
    release = await acquireIdentityLock(directory, context.uid, context.lockPorts, '.run-lock')
    const config = await loadHostConfig(context.configPath, context.uid)
    if (!config.ok)
      throw new IdentityFailure('Config is not usable. Run phosphor doctor to check it.')
    const { identity, key } = prepared.loaded
    const loop = createHeartbeat({
      now: context.now ?? Date.now,
      wait: context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal })),
      random: context.heartbeat?.random ?? (() => randomInt(3001) / 3000),
      client: (body, signal) => prepared.client.heartbeat(identity.hostId, key, body, signal),
      readiness:
        context.heartbeat?.readiness ??
        (() => checkReadiness(config.config, context.env, context.platform)),
      seq: context.heartbeat?.seq ?? createSequenceStore(directory, context.uid, identity.hostId),
      hostVersion: HOST_VERSION,
      signal: context.signal,
      log: context.print,
    })
    detach = context.attach?.({
      ...loop,
      log: { write: () => {}, hide: () => 'The Host could not finish.' },
    })
    return await loop.run()
  } catch (error) {
    const result = controlResult(error, context.signal)
    context.print(result.message)
    return result.exitCode
  } finally {
    detach?.()
    await release?.()
  }
}
