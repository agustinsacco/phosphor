import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))

import type { SessionMeta } from '@shared/models'
import { useSessionsStore } from './sessions'
import { useChatStore } from './chat'

const meta = { path: '/repo/yo.jsonl', cwd: '/repo', name: 'Bug hunt' } as SessionMeta
const invoke = vi.fn()
const piCommand = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** `pi:createSession` parked until the test says the process came up. */
function slowCreate(sessionId: string) {
  const gate = deferred<void>()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'pi:createSession') {
      await gate.promise
      return { sessionId, workspacePath: '/repo' }
    }
    return []
  })
  return gate
}

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'pi:createSession') return { sessionId: 'new', workspacePath: '/repo' }
    return []
  })
  piCommand.mockReset().mockResolvedValue({ success: false })
  vi.stubGlobal('window', { phosphor: { invoke, piCommand, onSessionPush: () => () => {} } })
  useSessionsStore.setState({
    live: {},
    disk: {},
    unread: {},
    baselines: {},
    activeSessionId: null,
    navSeq: 0,
    opening: null,
    deletingSessionKeys: [],
    bulkDelete: null,
  })
  useChatStore.setState({ sessions: {} })
})
afterEach(() => vi.unstubAllGlobals())

function live(id: string, diskPath?: string) {
  return { phosphorId: id, workspacePath: '/repo', diskPath }
}

describe('navigating between lanes', () => {
  it('acknowledges the click before the process exists', async () => {
    const gate = slowCreate('one')
    const opening = useSessionsStore.getState().openDiskSession('/repo', meta)
    // Synchronously, in the same tick as the click: this is the whole point.
    expect(useSessionsStore.getState().opening).toMatchObject({
      path: meta.path,
      reason: 'open',
      title: 'Bug hunt',
    })
    gate.resolve()
    await opening
    expect(useSessionsStore.getState().opening).toBeNull()
    expect(useSessionsStore.getState().activeSessionId).toBe('one')
  })

  it('still activates when the same lane is clicked again while it loads', async () => {
    const gate = slowCreate('one')
    const first = useSessionsStore.getState().openDiskSession('/repo', meta)
    // The second click coalesces onto the running open, whose own claim is now
    // stale. Without re-deciding activation here the click does nothing at all.
    const second = useSessionsStore.getState().openDiskSession('/repo', meta)
    gate.resolve()
    await Promise.all([first, second])
    expect(useSessionsStore.getState().activeSessionId).toBe('one')
    expect(useSessionsStore.getState().opening).toBeNull()
  })

  it('does not pull the screen to a lane the user has navigated away from', async () => {
    const gate = slowCreate('late')
    // What the home composer does on Enter, seconds before it reaches
    // `createSession`.
    const nav = useSessionsStore.getState().claimNav()
    const creating = useSessionsStore.getState().createSession('/repo', { nav })

    useSessionsStore.setState({ live: { elsewhere: live('elsewhere') } })
    useSessionsStore.getState().activate('elsewhere')

    gate.resolve()
    await creating
    expect(useSessionsStore.getState().activeSessionId).toBe('elsewhere')
    // Registered, just not on screen: it is in the sidebar and running.
    expect(useSessionsStore.getState().live.late).toBeDefined()
  })

  it('leaves the overlay down when an open fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pi:createSession') throw new Error('pi is missing')
      return []
    })
    await expect(useSessionsStore.getState().openDiskSession('/repo', meta)).rejects.toThrow(
      'pi is missing',
    )
    expect(useSessionsStore.getState().opening).toBeNull()
    expect(useSessionsStore.getState().activeSessionId).toBeNull()
  })
})

describe('restarting a lane', () => {
  it('holds the screen for the lane being restarted and gives it back', async () => {
    useSessionsStore.setState({ live: { a: live('a', meta.path) }, activeSessionId: 'a' })
    const gate = slowCreate('a2')
    const restarting = useSessionsStore.getState().restartSession('a', { label: 'Claude Opus 5' })
    expect(useSessionsStore.getState().opening).toMatchObject({
      reason: 'restart',
      title: 'Claude Opus 5',
    })
    gate.resolve()
    expect(await restarting).toBe('a2')
    expect(useSessionsStore.getState().activeSessionId).toBe('a2')
    expect(useSessionsStore.getState().opening).toBeNull()
  })

  it('restarts a background lane without moving the user', async () => {
    useSessionsStore.setState({
      live: { a: live('a', meta.path), b: live('b') },
      activeSessionId: 'b',
    })
    expect(await useSessionsStore.getState().restartSession('a', { label: 'x' })).toBe('new')
    expect(useSessionsStore.getState().activeSessionId).toBe('b')
    expect(useSessionsStore.getState().opening).toBeNull()
  })

  it('declines a lane with no transcript to resume from', async () => {
    useSessionsStore.setState({ live: { a: live('a') }, activeSessionId: 'a' })
    expect(await useSessionsStore.getState().restartSession('a', { label: 'x' })).toBeNull()
    expect(useSessionsStore.getState().opening).toBeNull()
  })
})
