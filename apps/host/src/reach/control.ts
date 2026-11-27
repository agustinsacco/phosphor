import type { KeyObject } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReachControlStage, ReachBudget } from '@phosphor/session-runtime/ops/reach'
import { executeRequest, type ClientPorts, type RequestArgs } from '../control/client-request'
import { ControlRequestFailure } from '../control/client-response'

/** The enrolled machine that signs reach requests; null before enrollment. */
export interface ReachControl {
  readonly url: string
  readonly hostId: string
  readonly key: KeyObject
}

export interface ReachControlPorts {
  readonly control: () => ReachControl | null
  readonly fetch?: ClientPorts['fetch']
  readonly now?: () => number
  readonly log?: ClientPorts['log']
  readonly trace?: string
}

export const CONTROL_STAGE_TEXT: Readonly<Record<ReachControlStage, string>> = {
  'control-unreachable':
    'Phosphor’s control service cannot be reached. Check your network and try again.',
  'control-timeout': 'Timed out waiting for Phosphor’s control service. Try again.',
  'rate-limited': 'Phosphor’s control service rate-limited the request. Wait before trying again.',
  'bad-response':
    'Phosphor’s control service returned an invalid response. Try again after checking service status.',
}

export function controlStage(error: unknown): ReachControlStage {
  return error instanceof ControlRequestFailure && error.stage ? error.stage : 'control-unreachable'
}

/** Each signed attempt gets a fresh nonce; only reach's directory and grant requests retry. */
export function createReachRequester(ports: ReachControlPorts) {
  const now = ports.now ?? Date.now
  let cooldown: { hostId: string; until: number } | undefined
  return async function request<T>(
    control: ReachControl,
    args: Omit<RequestArgs<T>, 'identity' | 'key'>,
    budget: ReachBudget = {},
  ): Promise<T> {
    const deadlineAt = budget.deadlineAt ?? now() + 22_000
    const signal = budget.signal
    if (cooldown?.hostId === control.hostId && now() < cooldown.until)
      throw new ControlRequestFailure('too-many-requests', 'rate-limited')
    const state = {
      url: control.url,
      trace: ports.trace ?? 'reach',
      ports: { fetch: ports.fetch, now, log: ports.log },
    }
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted || now() >= deadlineAt)
        throw new ControlRequestFailure('offline', 'control-timeout')
      try {
        return await executeRequest(state, {
          ...args,
          identity: { hostId: control.hostId },
          key: control.key,
          signal,
          deadlineAt,
        })
      } catch (error) {
        if (!(error instanceof ControlRequestFailure) || !error.stage) throw error
        ports.log?.('reach', 'control request failed', {
          route: args.path,
          stage: error.stage,
          cause: error.transport,
          attempt: attempt + 1,
        })
        if (error.stage === 'rate-limited') {
          cooldown = { hostId: control.hostId, until: now() + (error.retryAfterMs ?? 60_000) }
          throw error
        }
        const pause = 30 + Math.floor(Math.random() * 71)
        if (
          attempt > 0 ||
          (error.stage !== 'control-unreachable' && error.stage !== 'control-timeout') ||
          signal?.aborted ||
          now() + pause >= deadlineAt
        )
          throw error
        try {
          await delay(pause, undefined, { signal })
        } catch {
          throw new ControlRequestFailure('offline', 'control-timeout', 'AbortError')
        }
      }
    }
  }
}
