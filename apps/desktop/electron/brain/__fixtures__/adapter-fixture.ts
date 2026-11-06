import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { vi } from 'vitest'
import { openMemoryStore } from '@phosphor/memory-engine/service'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import type { BrainServiceOptions } from '../service-types'
import type { DesktopMemoryClient } from '../memory-client'
import type { MemoryRequest } from '../memory-protocol'
import { MEMORY_METHODS } from '../memory-protocol'
import { createMemoryHandler } from '../memory-worker-handler'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
export async function adapterFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'brain-adapter-')))
  const scope = join(root, 'repo')
  const directory = join(root, 'brain')
  await mkdir(scope)
  await mkdir(directory)
  execFileSync('git', ['init', '-b', 'main', scope], { stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-C',
      scope,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { stdio: 'ignore' },
  )
  const engine = openMemoryStore({
    directory: join(directory, 'db'),
    Database: loadSqlite().DatabaseSync,
  })
  const handler = createMemoryHandler(engine)
  let next = 0
  const store = Object.fromEntries(
    MEMORY_METHODS.map((method) => [
      method,
      async (...args: unknown[]) => {
        const result = handler({ id: ++next, method, args } as MemoryRequest)
        if (!result.ok) throw new Error(result.error)
        return result.data
      },
    ]),
  ) as DesktopMemoryClient
  const { lives, registry, embeds, options } = sessionFixture(root, directory)
  const model = { provider: 'openai', id: 'synthetic' }
  const snapshot = engine.setPrefs({
    enabled: true,
    recall: true,
    workspaces: [scope],
    processor: model,
    retentionDays: 30,
  })
  const evidence = engine.capture({
    scope,
    sessionId: 'source',
    entryId: 'entry-1',
    parentId: null,
    rootIds: ['entry-1'],
    branch: 'main',
    role: 'user',
    label: 'New user message',
    observedAt: Date.now(),
    text: 'Component Atlas depends on Mercury.',
  })!
  return {
    root,
    scope,
    directory,
    engine,
    store,
    lives,
    registry,
    embeds,
    options,
    model,
    snapshot,
    evidence,
    processorSession: (jobId: string) => processorSessionFixture(directory, model, lives, jobId),
    async cleanup() {
      engine.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function embeddingFixture() {
  const embeds = {
    status: () => ({
      phase: 'missing' as const,
      receivedBytes: 0,
      totalBytes: 0,
      modelId: BRAIN_EMBEDDING_MODEL.id,
      dimensions: 768,
    }),
    setEnabled: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    embed: vi.fn(async (_texts: string[], _kind: 'query' | 'document') => {
      throw new Error('Missing local model')
    }),
    dispose: vi.fn(),
  }
  return embeds
}

function sessionFixture(root: string, directory: string) {
  const lives = new Map<string, LiveSession>()
  const emitter = new EventEmitter()
  const registry = Object.assign(emitter, {
    get: (id: string) => lives.get(id),
    list: () =>
      [...lives.values()].map((live) => ({
        sessionId: live.sessionId,
        workspacePath: live.workspacePath,
      })),
  }) as unknown as BrainServiceOptions['registry']
  const embeds = embeddingFixture()
  const options: BrainServiceOptions = {
    directory,
    memoryWorkerPath: join(root, 'brain-memory-worker.js'),
    embeddings: embeds,
    resources: {
      workingExtension: join(root, 'brain.mjs'),
      processorExtension: join(root, 'brain-processor.mjs'),
    },
    sessions: {
      create: vi.fn(async () => {
        throw new Error('No inference in fixture')
      }),
      disposeBrain: vi.fn(async (id) => {
        lives.delete(id)
        emitter.emit('disposed', { sessionId: id })
      }),
    },
    registry,
    sessionPaths: createSessionPathRuntime(),
    processor: {
      resolve: vi.fn(async () => ({
        binaryPath: '/synthetic/pi',
        version: '1.4.0',
        env: { OPENAI_API_KEY: 'synthetic-not-real' },
      })),
      verifyTools: vi.fn(async () => {}),
    },
    onError: vi.fn(),
  }
  return { lives, registry, embeds, options }
}

async function processorSessionFixture(
  directory: string,
  model: { provider: string; id: string },
  lives: Map<string, LiveSession>,
  jobId: string,
) {
  const sessionDir = join(directory, 'sessions')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${jobId}.jsonl`)
  await writeFile(
    path,
    JSON.stringify({
      type: 'custom',
      customType: 'phosphor-brain-owner',
      data: { kind: 'brain', jobId },
    }) + '\n',
  )
  const client = Object.assign(new EventEmitter(), {
    request: vi.fn(async (command: { type: string }) =>
      command.type === 'get_state'
        ? { success: true, data: { model, sessionFile: path, sessionId: 'native-processor' } }
        : command.type === 'get_entries'
          ? {
              success: true,
              data: {
                entries: [
                  {
                    type: 'custom',
                    customType: 'phosphor-brain-owner',
                    data: { kind: 'brain', jobId },
                  },
                ],
              },
            }
          : { success: true },
    ),
    alive: true,
    sessionFile: path,
  })
  const live = {
    sessionId: 'processor',
    workspacePath: '/isolated',
    owner: { kind: 'brain' as const, jobId },
    client: client as unknown as PiRpcClient,
  }
  lives.set(live.sessionId, live)
  return { live, client, path }
}
