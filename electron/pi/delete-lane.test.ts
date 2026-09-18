import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { client: { sessionFile?: string } }>(),
  dispose: vi.fn(),
  trash: vi.fn(),
  clearDraft: vi.fn(),
  blobs: vi.fn(),
  cancelRoutine: vi.fn(),
  routine: vi.fn(),
}))
vi.mock('../registry', () => ({
  registry: {
    get: (id: string) => mocks.sessions.get(id),
    list: () =>
      [...mocks.sessions].map(([sessionId, s]) => ({ sessionId, diskPath: s.client.sessionFile })),
    dispose: mocks.dispose,
  },
}))
vi.mock('./session-deleter', () => ({ deleteSession: mocks.trash }))
vi.mock('../store', () => ({ clearDraft: mocks.clearDraft }))
vi.mock('../drafts-blobs', () => ({ deleteDraftBlobs: mocks.blobs }))
vi.mock('./session-accounts', () => ({ forgetSpawnAccount: vi.fn() }))
vi.mock('../routines/ownership', () => ({ isRoutineSession: mocks.routine }))
vi.mock('../routines', () => ({ cancelRoutineSession: mocks.cancelRoutine }))
import { deleteLane } from './delete-lane'
import { openSessionPath, withSessionPath } from './session-path-lock'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.sessions.clear()
  mocks.dispose.mockImplementation(async (id: string) => {
    mocks.sessions.delete(id)
  })
})

const add = (id: string, path?: string) => mocks.sessions.set(id, { client: { sessionFile: path } })

describe('deleteLane', () => {
  it('stops all duplicate writers, including unadopted handles, before trashing', async () => {
    add('a', '/session')
    add('b', '/session')
    add('other', '/other')
    mocks.trash.mockImplementation(async () => {
      expect([...mocks.sessions.keys()]).toEqual(['other'])
    })
    expect(await deleteLane('/session')).toEqual(['a', 'b'])
    expect(mocks.trash).toHaveBeenCalledExactlyOnceWith('/session')
    expect(mocks.clearDraft).toHaveBeenCalledWith('session:/session')
  })

  it('can stop an unresponsive lane with no known file, without asking it for state', async () => {
    add('booting')
    expect(await deleteLane(undefined, 'booting')).toEqual(['booting'])
    expect(mocks.sessions.size).toBe(0)
    expect(mocks.trash).not.toHaveBeenCalled()
  })

  it('uses main identity instead of a stale renderer path', async () => {
    add('fork', '/new-file')
    add('old-owner', '/old-file')
    await deleteLane('/old-file', 'fork')
    expect(mocks.sessions.has('old-owner')).toBe(true)
    expect(mocks.trash).toHaveBeenCalledExactlyOnceWith('/new-file')
  })

  it('captures a file learned while a pending lane is stopping', async () => {
    add('pending')
    mocks.dispose.mockImplementation(async (id: string) => {
      mocks.sessions.get(id)!.client.sessionFile = '/late-file'
      mocks.sessions.delete(id)
    })
    await deleteLane(undefined, 'pending')
    expect(mocks.trash).toHaveBeenCalledExactlyOnceWith('/late-file')
  })

  it('waits for a concurrent resume before collecting its writers', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const open = withSessionPath('/session', async () => {
      await gate
      add('late', '/session')
    })
    const deleting = deleteLane('/session')
    expect(mocks.trash).not.toHaveBeenCalled()
    release()
    await open
    expect(await deleting).toEqual(['late'])
    expect(mocks.sessions.size).toBe(0)
  })

  it('cancels a hung startup and queued opens rather than waiting forever', async () => {
    const started = vi.fn()
    const first = openSessionPath('/session', async (signal) => {
      started()
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      )
    })
    const firstResult = first.catch((error: Error) => error.message)
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    const queued = openSessionPath('/session', async () => {
      throw new Error('should not start')
    }).catch((error: Error) => error.name)
    await deleteLane('/session')
    expect(await firstResult).toBe('cancelled')
    expect(await queued).toBe('AbortError')
    expect(mocks.trash).toHaveBeenCalledExactlyOnceWith('/session')
  })

  it('does not trash anything when a writer cannot be stopped', async () => {
    add('a', '/session')
    mocks.dispose.mockRejectedValue(new Error('stop failed'))
    await expect(deleteLane('/session')).rejects.toThrow('stop failed')
    expect(mocks.trash).not.toHaveBeenCalled()
  })

  it('cancels an owned routine through its scheduler before deleting', async () => {
    add('routine', '/session')
    mocks.routine.mockReturnValue(true)
    mocks.trash.mockImplementation(async () => {
      expect(mocks.cancelRoutine).toHaveBeenCalledWith('routine')
    })
    await deleteLane('/session')
    expect(mocks.cancelRoutine).toHaveBeenCalledExactlyOnceWith('routine')
  })
})
