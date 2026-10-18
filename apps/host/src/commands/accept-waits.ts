import { CONTEXT_BREAKDOWN_STATUS_KEY } from '@phosphor/pi-extensions/status-keys'
import type { SessionPush } from '@phosphor/shared/models'
import type { RpcCommand, RpcCommandType, RpcResponseDataMap } from '@phosphor/shared/rpc'
import type { HostRuntime } from '../session/runtime'

/** A wait passed its deadline. */
export class TimedOut extends Error {}

export async function send<K extends RpcCommandType>(
  runtime: Pick<HostRuntime, 'command'>,
  sessionId: string,
  command: Extract<RpcCommand, { type: K }>,
  by: Deadline,
): Promise<RpcResponseDataMap[K]> {
  const response = await within(
    runtime.command(sessionId, command),
    by,
    `answer to ${command.type}`,
  )
  if (!response.success) throw new Error(`${command.type} failed: ${response.error}`)
  return response.data as RpcResponseDataMap[K]
}

/** A moment a wait must end by, and the span it was given, for its message. */
export interface Deadline {
  at: number
  ms: number
}
export const deadline = (ms: number): Deadline => ({ at: Date.now() + ms, ms })
const left = (by: Deadline) => Math.max(0, by.at - Date.now())

export const isBreakdownStatus = (push: SessionPush) =>
  push.kind === 'extension-ui' &&
  push.request.method === 'setStatus' &&
  push.request.statusKey === CONTEXT_BREAKDOWN_STATUS_KEY

export const isTextDelta = (push: SessionPush) =>
  push.kind === 'event' &&
  push.event.type === 'message_update' &&
  push.event.assistantMessageEvent.type === 'text_delta'

/** A session's pushes, and waits on them that fail when pi exits. */
export function watcher() {
  const pushes: SessionPush[] = []
  const waiting = new Set<() => void>()
  const events = <T extends string>(type: T) =>
    pushes.flatMap((push) =>
      push.kind === 'event' && push.event.type === type
        ? [push.event as Extract<typeof push.event, { type: T }>]
        : [],
    )
  return {
    deliver(push: SessionPush): void {
      pushes.push(push)
      for (const check of waiting) check()
    },
    events,
    count: (type: string) => events(type).length,
    mark: () => pushes.length,
    since: (mark: number) => pushes.slice(mark),
    /** The first truthy value of `find`, checked on every push until `by`. */
    until<T>(find: () => T | undefined, by: Deadline, what: string): Promise<T> {
      const exits = pushes.filter((push) => push.kind === 'exit').length
      return new Promise<T>((resolve, reject) => {
        const done = (settle: () => void) => {
          clearTimeout(timer)
          waiting.delete(check)
          settle()
        }
        const check = () => {
          const found = find()
          if (found) return done(() => resolve(found))
          const exit = pushes.filter((push) => push.kind === 'exit')[exits]
          if (exit?.kind === 'exit') {
            const how = exit.signal ?? `code ${exit.code}`
            done(() => reject(new Error(`pi exited (${how}) while waiting for ${what}`)))
          }
        }
        const timer = setTimeout(
          () => done(() => reject(new Error(`no ${what} within ${by.ms} ms`))),
          left(by),
        )
        waiting.add(check)
        check()
      })
    },
  }
}

/** The promise's value, unless `by` comes first. */
export async function within<T>(promise: Promise<T>, by: Deadline, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(`no ${what} within ${by.ms} ms`)), left(by))
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}
