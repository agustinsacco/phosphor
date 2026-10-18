import { HOST_LIMITS, type LaneEvent } from '@phosphor/shared/host-protocol'
import { opHash, type HostStore } from '../store'
import { deliver, log, rejected, terminal, type ReceiptPorts } from './receipts'
import {
  COMMAND_CLOSE_GRACE_MS,
  track,
  type Answer,
  type CommandRouter,
  type CommandState,
  type ExecuteJob,
  type Execution,
  type Job,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
  type LaneQueue,
  type OperationIdentity,
} from './state'

export type QueuePorts = ReceiptPorts & {
  store: Pick<HostStore, 'getReceipt' | 'beginRequest'>
}

/** Forget an idle queue. Anything queued, running, held or owing control keeps it. */
export function cleanup(state: CommandState, key: string, queue: LaneQueue): void {
  if (state.closed) return
  if (
    !queue.draining &&
    !queue.jobs.length &&
    !queue.outstanding &&
    !queue.holds &&
    !queue.controlUnpublished
  )
    state.queues.delete(key)
}

export function queueFor(state: CommandState, key: string): LaneQueue {
  let queue = state.queues.get(key)
  if (!queue) {
    queue = { jobs: [], outstanding: 0, holds: 0, draining: false, controlUnpublished: false }
    state.queues.set(key, queue)
  }
  return queue
}

/** A failed control publication is owed: the queue's next lane job republishes it. */
export function publish(
  state: CommandState,
  ports: Pick<LaneCommandPorts, 'publish' | 'log'>,
  laneId: string,
  event: LaneEvent,
  queue: LaneQueue,
): boolean {
  if (state.closed) return false
  try {
    ports.publish(laneId, event)
    if (event.kind === 'control') queue.controlUnpublished = false
    return true
  } catch {
    if (event.kind === 'control') queue.controlUnpublished = true
    log(ports, 'lane.publish_failed', { laneId, kind: event.kind })
    return false
  }
}

/** After a deadline, only the operation identity and slot survive, not the job or payload. */
export function answer<T>(
  state: CommandState,
  ports: Pick<LaneCommandPorts, 'log'>,
  identity: OperationIdentity,
  queue: LaneQueue,
  promise: Promise<T>,
): Promise<Answer<T>> {
  track(state, promise)
  queue.outstanding++
  return new Promise((resolve) => {
    let reply: ((answer: Answer<T>) => void) | undefined = resolve
    const timer = setTimeout(() => {
      reply?.({ answered: false, reason: 'deadline' })
      reply = undefined
    }, HOST_LIMITS.commandAnswerMs)
    timer.unref()
    const complete = (value: Answer<T>) => {
      queue.outstanding--
      clearTimeout(timer)
      if (reply) {
        reply(value)
        reply = undefined
      } else {
        log(ports, 'lane.command_late', {
          laneId: identity.laneId,
          requestId: identity.requestId,
          op: identity.opType,
        })
      }
      cleanup(state, identity.laneId, queue)
    }
    promise
      .then(
        (value) => complete({ answered: true, value }),
        () => complete({ answered: false, reason: 'transport' }),
      )
      .catch(() => {})
  })
}

// Invoke outside answer's settle closures so an unresolved runtime cannot retain run or job.
export function dispatch<T>(
  state: CommandState,
  ports: Pick<LaneCommandPorts, 'log'>,
  job: Job,
  queue: LaneQueue,
  run: () => Promise<T> | T,
): Promise<Answer<T>> {
  let promise: Promise<T>
  try {
    promise = Promise.resolve(run())
  } catch {
    promise = Promise.reject(new Error('transport'))
  }
  return answer(
    state,
    ports,
    { laneId: job.frame.laneId ?? '', requestId: job.frame.requestId, opType: job.frame.op.type },
    queue,
    promise,
  )
}

/** Run a queue's jobs in order. A non-detached execution holds the queue until it completes. */
export async function drain(
  state: CommandState,
  ports: ReceiptPorts,
  execute: ExecuteJob,
  key: string,
  queue: LaneQueue,
): Promise<void> {
  queue.draining = true
  while (!state.closing && queue.jobs.length && !queue.holds) {
    const job = queue.jobs[0]
    if (!job) break
    let execution: Execution | void = undefined
    try {
      execution = execute(job, queue)
    } catch {
      terminal(
        state,
        ports,
        job,
        { requestId: job.frame.requestId, status: 'unknown' },
        true,
        'host',
      )
    } finally {
      queue.jobs.shift()
      if (!execution) job.resolve()
    }
    if (execution) {
      const completion = execution.completion
        .catch(() => {
          terminal(
            state,
            ports,
            job,
            { requestId: job.frame.requestId, status: 'unknown' },
            true,
            'host',
          )
        })
        .finally(job.resolve)
        .catch(() => {})
      track(state, completion)
      if (!execution.detached) await completion
    }
  }
  queue.draining = false
  cleanup(state, key, queue)
}

/** Admit, record and enqueue one command. Refusals before recording are delivered to the attempt's connection. */
export function submit(
  state: CommandState,
  ports: QueuePorts,
  router: CommandRouter,
  client: LaneCommandClient,
  frame: LaneCommandFrame,
): Promise<void> {
  if (state.closing) return Promise.resolve()
  const jobBase = { client, frame, started: ports.now() }
  const immediate = { ...jobBase, resolve: () => {} }
  const caps = client.currentCaps?.() ?? client.caps
  if (!router.capabilityFor(frame.op).every((cap) => caps.includes(cap))) {
    rejected(state, ports, immediate, 'forbidden', false)
    return Promise.resolve()
  }
  const key = frame.laneId ?? ''
  let queue = state.queues.get(key)
  if (
    (queue?.jobs.length ?? 0) + (queue?.outstanding ?? 0) >= state.limit &&
    ports.store.getReceipt(frame.requestId, client.id) === null
  ) {
    rejected(state, ports, immediate, 'busy', false)
    return Promise.resolve()
  }
  const begin = ports.store.beginRequest(
    frame.requestId,
    client.id,
    opHash(frame.op),
    frame.laneId ?? null,
  )
  if (begin.kind === 'existing') {
    deliver(ports, client.id, begin.receipt, client.connectionId)
    return Promise.resolve()
  }
  if (begin.kind !== 'new') {
    rejected(state, ports, immediate, begin.kind, false)
    return Promise.resolve()
  }
  queue ??= queueFor(state, key)
  const completion = new Promise<void>((resolve) => queue.jobs.push({ ...jobBase, resolve }))
  if (!queue.draining && !queue.holds)
    void drain(state, ports, router.execute, key, queue).catch(() => {})
  return completion
}

export function status(
  state: CommandState,
  ports: Pick<LaneCommandPorts, 'deliver'> & { store: Pick<HostStore, 'getReceipt'> },
  clientId: string,
  requestId: string,
  connectionId?: string,
): void {
  if (state.closing) return
  deliver(
    ports,
    clientId,
    ports.store.getReceipt(requestId, clientId) ?? { requestId, status: 'unknown' },
    connectionId,
  )
}

/** Resolve queued jobs, wait up to the grace for work, then go closed. Idempotent. */
export function close(state: CommandState): Promise<void> {
  if (state.closePromise) return state.closePromise
  state.closing = true
  for (const queue of state.queues.values()) {
    for (const job of queue.jobs.splice(0)) job.resolve()
  }
  state.closePromise = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...state.work]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, COMMAND_CLOSE_GRACE_MS)
          timer.unref()
        }),
      ])
    } finally {
      state.closed = true
      clearTimeout(timer)
      state.queues.clear()
    }
  })()
  return state.closePromise
}
