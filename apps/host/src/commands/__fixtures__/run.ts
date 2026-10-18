import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readiness } from '@phosphor/shared/control-api'
import { controlMachine } from '../../control/__fixtures__/machine'
import type { RunContext } from '../run'

export const readiness: Readiness = { pi: 'ok', claude: 'ok', tailscale: 'ok' }

export async function createRunFixture() {
  const machine = await controlMachine()
  try {
    const repository = join(machine.root, 'repository')
    await mkdir(repository)
    machine.config.repositories = [repository]
    await writeFile(machine.configPath, JSON.stringify(machine.config), { mode: 0o600 })
    const context = (): RunContext => ({
      ...machine.context,
      env: {
        XDG_STATE_HOME: join(machine.root, 'state'),
        PI_CODING_AGENT_SESSION_DIR: join(machine.root, 'sessions'),
      },
      home: machine.root,
      nodeVersion: process.versions.node,
      defaultResourceRoot: join(machine.root, 'resources'),
      heartbeat: { readiness: async () => readiness, random: () => 0 },
    })
    return { machine, context }
  } catch (error) {
    await machine.cleanup()
    throw error
  }
}

export function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Bound a causal wait, but fail promptly if initialization ends before the event. */
export async function waitForRunEvent(
  event: Promise<void>,
  run: Promise<number>,
  timeoutMs = 5000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      event,
      run.then((code) => {
        throw new Error(`Host ended before the awaited event (exit ${code})`)
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for Host event')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Running transport remains pending until shutdown aborts it; stopping is acknowledged. */
export function heartbeatBarrier() {
  const running = deferred()
  const states: string[] = []
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const request: unknown = JSON.parse(String(init?.body))
    if (
      request === null ||
      typeof request !== 'object' ||
      !('state' in request) ||
      typeof request.state !== 'string'
    )
      throw new Error('Invalid fixture heartbeat')
    states.push(request.state)
    if (request.state === 'stopping') return Response.json({ accepted: true, nextInSec: 30 })
    const signal = init?.signal
    if (!signal) throw new Error('Missing fixture heartbeat signal')
    // Install the listener before publishing the startup barrier.
    const cancelled = new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new Error('cancelled'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    running.resolve()
    return cancelled
  }
  return { running: running.promise, states, fetch }
}
