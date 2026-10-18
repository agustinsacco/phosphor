import { describe, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionDeletion, type SessionDeletionRuntime } from './session-deletion'
import { createSessionPathRuntime, sessionPathKey } from './session-path-lock'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function harness() {
  const h = sessionFixture()
  const paths = createSessionPathRuntime()
  const locked = new Set<string>()
  const runtime: SessionDeletionRuntime = {
    registry: h.registry,
    paths: {
      ...paths,
      cancelSessionOpens: vi.fn(paths.cancelSessionOpens),
      withSessionPath: (file, run) =>
        paths.withSessionPath(file, async () => {
          const key = sessionPathKey(file)
          locked.add(key)
          try {
            return await run()
          } finally {
            locked.delete(key)
          }
        }),
    },
    ownsRoutine: vi.fn(() => false),
    cancelRoutine: vi.fn(async () => {}),
    forgetAccount: vi.fn(),
    deleteTranscript: vi.fn(async (file: string) => {
      expect(locked.has(sessionPathKey(file)), `lock held for ${file}`).toBe(true)
      expect(h.registry.list().filter((s) => s.diskPath === file)).toEqual([])
    }),
    deleteDraft: vi.fn(async () => {}),
    assertDeletable: vi.fn(),
  }
  const add = (file?: string) => {
    const session = h.registry.create('/repo', { sessionPath: file })
    return { ...session, client: h.clients[h.clients.length - 1]! }
  }
  return { ...h, add, runtime, paths: runtime.paths, remove: createSessionDeletion(runtime) }
}

describe('deletion of identities learned while stopping', () => {
  it('takes the newly learned transcript lock before trashing it', async () => {
    const h = harness()
    const lane = h.add('/old.jsonl')
    const stopping = deferred()
    const stopped = deferred()
    lane.client.dispose.mockImplementation(async () => {
      stopping.resolve()
      await stopped.promise
      lane.client.sessionFile = '/new.jsonl'
    })
    const removing = h.remove('/old.jsonl', lane.sessionId)
    await stopping.promise
    stopped.resolve()
    expect(await removing).toEqual([lane.sessionId])
    expect(h.runtime.deleteTranscript).toHaveBeenNthCalledWith(1, '/old.jsonl')
    expect(h.runtime.deleteTranscript).toHaveBeenNthCalledWith(2, '/new.jsonl')
    expect(h.runtime.deleteDraft).toHaveBeenCalledTimes(2)
  })
})
