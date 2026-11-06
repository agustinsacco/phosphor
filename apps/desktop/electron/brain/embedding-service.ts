import { availableParallelism } from 'node:os'
import { utilityProcess } from 'electron'
import { log } from '../debug-log'
import type { EmbeddingProcess } from '@phosphor/brain-runtime/embedding/embedding-client'
import { createEmbeddingController } from '@phosphor/brain-runtime/embedding/embedding-controller'
import type {
  BrainEmbeddingOptions,
  BrainEmbeddings,
} from '@phosphor/brain-runtime/embedding/embedding-port'
import type {
  FromEmbeddingWorker,
  ToEmbeddingWorker,
} from '@phosphor/brain-runtime/embedding/embedding-protocol'
import {
  embeddingPlatformSupported,
  embeddingThreads,
} from '@phosphor/brain-runtime/embedding/model-manifest'

/**
 * Brain's local embeddings, bound to Electron. Nothing here loads the native
 * runtime: only the utility process does, after an explicit enable or download,
 * so an unsupported platform or a broken install cannot affect app startup.
 */
export function createBrainEmbeddings(options: BrainEmbeddingOptions): BrainEmbeddings {
  return createEmbeddingController({
    directory: options.directory,
    onStatus: options.onStatus,
    supported: embeddingPlatformSupported(process.platform, process.arch),
    threads: embeddingThreads(availableParallelism()),
    spawn: () => spawnEmbeddingProcess(options.workerPath),
    log: (message) => log('brain', message),
  })
}

/** Hugging Face credentials are never needed: the worker reads local files only. */
export function embeddingWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { HF_TOKEN: _token, HF_ACCESS_TOKEN: _access, ...rest } = env
  return rest
}

function spawnEmbeddingProcess(workerPath: string): EmbeddingProcess {
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'Phosphor Brain Embeddings',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: embeddingWorkerEnv(process.env),
  })
  child.stderr?.on('data', (chunk: Buffer) => log('brain', chunk.toString().slice(0, 2000)))
  return {
    post: (message: ToEmbeddingWorker) => child.postMessage(message),
    onMessage: (listener) =>
      child.on('message', (message: FromEmbeddingWorker) => listener(message)),
    onExit: (listener) => child.on('exit', () => listener()),
    kill: () => void child.kill(),
  }
}
