import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { syntheticInference } from './brain-native-smoke'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { unverifiedFiles } from '@phosphor/brain-runtime/embedding/embedding-files'
import { embeddingInput } from '@phosphor/brain-runtime/embedding/model-manifest'
import type { FromEmbeddingWorker } from '@phosphor/brain-runtime/embedding/embedding-protocol'
import type { FromSearchWorker } from '@phosphor/brain-runtime/search/search-protocol'
import {
  BRAIN_EMBEDDING_WORKER,
  BRAIN_SEARCH_WORKER,
  BRAIN_WORKER_DIR,
} from '../src/brain/packaged-runtime'

function reply<T>(worker: ChildProcess, request: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('error', failed).off('disconnect', disconnected).off('message', received)
    }
    const failed = (error: Error) => {
      cleanup()
      reject(error)
    }
    const disconnected = () => failed(new Error('Brain worker disconnected before replying.'))
    const received = (message: T) => {
      cleanup()
      resolve(message)
    }
    worker.once('error', failed).once('disconnect', disconnected).once('message', received)
    worker.send(request, (error) => {
      if (error) failed(error)
    })
  })
}

async function searchSmoke(worker: ChildProcess, path: string) {
  openBrainStore({ path, Database: loadSqlite().DatabaseSync }).close()
  worker.send({ type: 'open', path })
  const response = await reply<FromSearchWorker>(worker, {
    type: 'call',
    id: 1,
    method: 'refresh',
    args: [],
  })
  assert.equal(response.type, 'result')
  assert.equal(response.id, 1)
  worker.send({ type: 'close' })
}

async function embeddingSmoke(worker: ChildProcess, model: string | undefined) {
  const before = await reply<FromEmbeddingWorker>(worker, {
    type: 'embed',
    id: 1,
    texts: ['Harbor'],
  })
  assert.equal(before.type, 'error')
  assert.equal(before.id, 1)
  if (!model) return
  assert.deepEqual(await unverifiedFiles(model), [])
  const loaded = await reply<FromEmbeddingWorker>(worker, {
    type: 'load',
    id: 2,
    modelRoot: dirname(model),
    modelName: basename(model),
    threads: 2,
  })
  assert.deepEqual(loaded, { type: 'done', id: 2 })
  const response = await reply<FromEmbeddingWorker>(worker, {
    type: 'embed',
    id: 3,
    texts: [
      embeddingInput('Rina Okafor reviews Kestrel billing and reconciles invoices.', 'document'),
      embeddingInput('Mara Voss leads the Northwind documentation project.', 'document'),
      embeddingInput('Who is responsible for Kestrel invoices?', 'query'),
    ],
  })
  assert.equal(response.type, 'vectors')
  assert.equal(response.id, 3)
  const [first, second, query] = response.vectors
  assert(first && second && query)
  for (const vector of [first, second, query]) {
    assert.equal(vector.length, 768)
    assert(Math.abs(Math.hypot(...vector) - 1) < 0.0001)
  }
  const score = (vector: number[]) => vector.reduce((sum, value, i) => sum + value * query[i]!, 0)
  assert(score(first) > score(second))
}

function startWorker(dir: string, file: string) {
  // Packaged Host workers use process IPC, not worker_threads, and inherit no Host flags.
  const worker = fork(join(dir, BRAIN_WORKER_DIR, file), [], {
    env: { PATH: '/usr/bin:/bin' },
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  // Handle startup failures even when the other worker is still being probed.
  worker.on('error', () => {})
  return worker
}

async function stopWorker(worker: ChildProcess) {
  if (worker.exitCode !== null || worker.signalCode !== null || !worker.pid) return
  const exited = once(worker, 'exit')
  worker.kill('SIGKILL')
  await exited
}

const [dir, model] = process.argv.slice(2)
assert(dir)
const start = performance.now()
await syntheticInference(dir)
const temp = mkdtempSync(join(tmpdir(), 'host-brain-smoke-'))
const search = startWorker(dir, BRAIN_SEARCH_WORKER)
const embedding = startWorker(dir, BRAIN_EMBEDDING_WORKER)
try {
  await searchSmoke(search, join(temp, 'brain.sqlite'))
  await embeddingSmoke(embedding, model)
  console.log(
    `Host Brain ${model ? 'verified model' : 'synthetic CPU inference'} and worker smoke: ${Math.round(performance.now() - start)} ms, peak RSS ${process.resourceUsage().maxRSS} KiB`,
  )
} finally {
  await Promise.all([stopWorker(search), stopWorker(embedding)])
  rmSync(temp, { recursive: true, force: true })
}
