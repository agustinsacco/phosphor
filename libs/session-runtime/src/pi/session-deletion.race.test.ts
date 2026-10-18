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

describe('follow-up deletion admission', () => {
  it('cancels active and queued resumes and disposes their owner before trashing', async () => {
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
    const resuming = deferred()
    const resumed = h.paths.openSessionPath('/new.jsonl', async (signal) => {
      resuming.resolve()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      // An in-flight startup may still register a handle as it drains cancellation.
      return h.add('/new.jsonl')
    })
    await resuming.promise
    const queuedRun = vi.fn(async () => {})
    const queued = h.paths
      .openSessionPath('/new.jsonl', queuedRun)
      .catch((error: Error) => error.name)
    // The old lane's shutdown must not block unrelated admission.
    expect(await h.paths.openSessionPath('/other.jsonl', async () => 'opened')).toBe('opened')
    stopped.resolve()
    try {
      const disposed = await removing
      const late = await resumed
      expect(disposed).toEqual([lane.sessionId, late.sessionId])
      expect(late.client.dispose).toHaveBeenCalledOnce()
      expect(await queued).toBe('AbortError')
      expect(queuedRun).not.toHaveBeenCalled()
      expect(h.runtime.deleteTranscript).toHaveBeenCalledTimes(2)
      expect(h.runtime.forgetAccount).toHaveBeenCalledWith(late.sessionId)
    } finally {
      h.paths.cancelSessionOpens('/new.jsonl')
      await resumed
      await queued
    }
  })

  it('releases original locks before two cross-changing deletions follow up', async () => {
    const h = harness()
    const a = h.add('/a.jsonl')
    const b = h.add('/b.jsonl')
    const aStopping = deferred()
    const bStopping = deferred()
    const stopped = deferred()
    a.client.dispose.mockImplementation(async () => {
      aStopping.resolve()
      await stopped.promise
      a.client.sessionFile = '/b.jsonl'
    })
    b.client.dispose.mockImplementation(async () => {
      bStopping.resolve()
      await stopped.promise
      b.client.sessionFile = '/a.jsonl'
    })
    const removingA = h.remove('/a.jsonl', a.sessionId)
    const removingB = h.remove('/b.jsonl', b.sessionId)
    await Promise.all([aStopping.promise, bStopping.promise])
    stopped.resolve()
    expect(await Promise.all([removingA, removingB])).toEqual([[a.sessionId], [b.sessionId]])
    expect(h.registry.list()).toEqual([])
    expect(h.runtime.deleteTranscript).toHaveBeenCalledTimes(4)
  })

  it('locks a path learned by a no-file bootstrap and stops its intervening owner', async () => {
    const h = harness()
    const lane = h.add()
    let lateId = ''
    lane.client.dispose.mockImplementation(async () => {
      lane.client.sessionFile = '/bootstrapped.jsonl'
      lateId = h.add('/bootstrapped.jsonl').sessionId
    })
    expect(await h.remove(undefined, lane.sessionId)).toEqual([lane.sessionId, lateId])
    expect(h.runtime.deleteTranscript).toHaveBeenCalledExactlyOnceWith('/bootstrapped.jsonl')
    expect(h.runtime.deleteDraft).toHaveBeenCalledExactlyOnceWith('/bootstrapped.jsonl')
    expect(h.runtime.forgetAccount).toHaveBeenCalledTimes(2)
  })

  it('stops a no-file bootstrap that never learns an identity without deleting files', async () => {
    const h = harness()
    const lane = h.add()
    expect(await h.remove(undefined, lane.sessionId)).toEqual([lane.sessionId])
    expect(h.runtime.deleteTranscript).not.toHaveBeenCalled()
    expect(h.runtime.deleteDraft).not.toHaveBeenCalled()
    expect(h.runtime.forgetAccount).toHaveBeenCalledExactlyOnceWith(lane.sessionId)
  })

  it('deduplicates aliases in the queue and already visited identity cycles', async () => {
    const h = harness()
    const a = h.add('/old.jsonl')
    const alias = h.add('/folder/../old.jsonl')
    const b = h.add('/new.jsonl')
    a.client.dispose.mockImplementation(async () => {
      a.client.sessionFile = '/new.jsonl'
    })
    alias.client.dispose.mockImplementation(async () => {
      alias.client.sessionFile = '/folder/../new.jsonl'
    })
    b.client.dispose.mockImplementation(async () => {
      b.client.sessionFile = '/old.jsonl'
    })
    expect(await h.remove('/old.jsonl')).toEqual([a.sessionId, alias.sessionId, b.sessionId])
    expect(h.runtime.deleteTranscript).toHaveBeenCalledTimes(2)
    expect(h.runtime.deleteTranscript).toHaveBeenNthCalledWith(1, '/old.jsonl')
    expect(h.runtime.deleteTranscript).toHaveBeenNthCalledWith(2, '/new.jsonl')
    expect(h.paths.cancelSessionOpens).toHaveBeenCalledTimes(2)
  })

  it('re-lists owners and honors their veto after waiting for the discovered lock', async () => {
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
    const resuming = deferred()
    const resumed = deferred()
    const veto = new Error('owner refuses deletion')
    const guarded = h.paths.withSessionPath('/new.jsonl', async () => {
      resuming.resolve()
      await resumed.promise
      const late = h.add('/new.jsonl')
      vi.mocked(h.runtime.assertDeletable!).mockImplementation((id) => {
        if (id === late.sessionId) throw veto
      })
      return late
    })
    await resuming.promise
    const cancelled = deferred()
    vi.mocked(h.paths.cancelSessionOpens).mockImplementation((file) => {
      if (file === '/new.jsonl') cancelled.resolve()
    })
    stopped.resolve()
    await cancelled.promise
    resumed.resolve()
    const late = await guarded
    await expect(removing).rejects.toThrow(veto)
    expect(late.client.dispose).not.toHaveBeenCalled()
    expect(h.registry.get(late.sessionId)).toBeDefined()
    expect(h.runtime.deleteTranscript).toHaveBeenCalledExactlyOnceWith('/old.jsonl')
    expect(h.runtime.deleteDraft).toHaveBeenCalledExactlyOnceWith('/old.jsonl')
    expect(h.runtime.forgetAccount).not.toHaveBeenCalledWith(late.sessionId)
  })

  it('cancels a discovered routine and forgets its account only after disposal', async () => {
    const h = harness()
    const lane = h.add('/old.jsonl')
    const routine = h.add('/new.jsonl')
    const events: string[] = []
    lane.client.dispose.mockImplementation(async () => {
      lane.client.sessionFile = '/new.jsonl'
    })
    vi.mocked(h.runtime.ownsRoutine).mockImplementation((id) => id === routine.sessionId)
    vi.mocked(h.runtime.cancelRoutine).mockImplementation(async (id) => {
      events.push(`cancel:${id}`)
    })
    routine.client.dispose.mockImplementation(async () => {
      events.push(`dispose:${routine.sessionId}`)
    })
    vi.mocked(h.runtime.forgetAccount).mockImplementation((id) => {
      events.push(`forget:${id}`)
    })
    expect(await h.remove('/old.jsonl')).toEqual([lane.sessionId, routine.sessionId])
    expect(events).toEqual([
      `forget:${lane.sessionId}`,
      `cancel:${routine.sessionId}`,
      `dispose:${routine.sessionId}`,
      `forget:${routine.sessionId}`,
    ])
    expect(h.runtime.deleteTranscript).toHaveBeenCalledTimes(2)
  })
})
