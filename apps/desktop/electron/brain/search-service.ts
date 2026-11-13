import { utilityProcess } from 'electron'
import { log } from '../debug-log'
import {
  createSearchClient,
  type SearchProcess,
} from '@phosphor/brain-runtime/search/search-client'
import type { BrainSearchPort } from '@phosphor/brain-runtime/types'
import type {
  FromSearchWorker,
  ToSearchWorker,
} from '@phosphor/brain-runtime/search/search-protocol'

/** The search process reads one local file; it needs no credentials or tokens from main. */
export function searchWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'USERPROFILE']
  return Object.fromEntries(keep.flatMap((key) => (env[key] ? [[key, env[key]]] : [])))
}

/** Brain search, bound to an Electron utility process that starts on the first search. */
export function createDesktopSearch(path: string, workerPath: string): BrainSearchPort {
  return createSearchClient({
    path,
    spawn: () => spawnSearchProcess(workerPath),
    log: (message) => log('brain', message),
  })
}

function spawnSearchProcess(workerPath: string): SearchProcess {
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'Phosphor Brain Search',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: searchWorkerEnv(process.env),
  })
  child.stderr?.on('data', (chunk: Buffer) => log('brain', chunk.toString().slice(0, 2000)))
  return {
    post: (message: ToSearchWorker) => child.postMessage(message),
    onMessage: (listener) => child.on('message', (message: FromSearchWorker) => listener(message)),
    onExit: (listener) => child.on('exit', () => listener()),
    kill: () => void child.kill(),
  }
}
