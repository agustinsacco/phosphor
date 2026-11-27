import { fork } from 'node:child_process'

/** All a Brain worker inherits: it reads local files only, so no credentials or tokens. */
const WORKER_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const

export function brainWorkerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(WORKER_ENV.flatMap((key) => (env[key] ? [[key, env[key]]] : [])))
}

export interface BrainWorkerOptions {
  /** A bundled worker entry beside the Host; never a path from a surface. */
  workerPath: string
  /** V8 heap ceiling for the worker, in MB. */
  heapMb: number
  log(message: string): void
  env?: NodeJS.ProcessEnv
}

/** The process half of a worker protocol, as `search-client` and `embedding-client` expect it. */
export interface BrainWorkerProcess<To, From> {
  post(message: To): void
  onMessage(listener: (message: From) => void): void
  onExit(listener: () => void): void
  kill(): void
}

/**
 * A Brain worker in its own Node process: a crash or a stuck native call takes nothing else down,
 * and `kill` always ends it. It inherits no Host flags (an inspector, a loader) and a small env.
 */
export function forkBrainWorker<To, From>(
  options: BrainWorkerOptions,
): BrainWorkerProcess<To, From> {
  const child = fork(options.workerPath, [], {
    env: brainWorkerEnv(options.env ?? process.env),
    execArgv: [`--max-old-space-size=${options.heapMb}`],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr?.on('data', (chunk: Buffer) => options.log(chunk.toString().slice(0, 2000)))
  // A worker that fails to start reports through `exit`; the clients fail what is pending.
  child.on('error', (error) => options.log(`Brain worker failed: ${error.message}`))
  return {
    post(message) {
      if (child.connected) child.send(message as object)
    },
    onMessage: (listener) => child.on('message', (message) => listener(message as From)),
    onExit: (listener) => child.on('exit', () => listener()),
    kill: () => void child.kill(),
  }
}
