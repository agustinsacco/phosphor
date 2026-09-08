import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { shouldRefreshStatsOn, useSessionsStore } from './sessions'
import { getActiveWorkspace } from './workspaces'

const meta: SessionMeta = {
  path: '/repo/a.jsonl',
  sessionId: 'a',
  cwd: '/repo',
  createdAt: '2026-08-09T00:00:00.000Z',
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  entryCount: 1,
  branchCount: 0,
  mtimeMs: 0,
  lastActivityAt: '2026-08-09T00:00:00.000Z',
}

describe('shouldRefreshStatsOn', () => {
  describe('without usage on deltas (pi < 0.84.2)', () => {
    it('refreshes on message_end and tool_execution_end (live climb during a run)', () => {
      // Regression: stats previously only refreshed on agent_end/compaction_end,
      // so the context meter and token count looked frozen for the whole
      // duration of a turn and only jumped once it fully finished. Polling is
      // the ONLY thing that moves the meter mid-turn on these builds.
      expect(shouldRefreshStatsOn('message_end', false)).toBe(true)
      expect(shouldRefreshStatsOn('tool_execution_end', false)).toBe(true)
      expect(shouldRefreshStatsOn('agent_end', false)).toBe(true)
      expect(shouldRefreshStatsOn('compaction_end', false)).toBe(true)
    })

    it('does not refresh on high-frequency streaming deltas', () => {
      expect(shouldRefreshStatsOn('message_update', false)).toBe(false)
      expect(shouldRefreshStatsOn('tool_execution_update', false)).toBe(false)
      expect(shouldRefreshStatsOn('agent_start', false)).toBe(false)
      expect(shouldRefreshStatsOn('message_start', false)).toBe(false)
      expect(shouldRefreshStatsOn('tool_execution_start', false)).toBe(false)
    })
  })

  describe('with usage on deltas (pi >= 0.84.2)', () => {
    it('polls only at boundaries pi computes things the stream cannot carry', () => {
      // The meter climbs from message_update.usage; the poll re-syncs the
      // authoritative context estimate and message counts. MEASURED without
      // this: ~26 get_session_stats round trips per user turn.
      expect(shouldRefreshStatsOn('agent_end', true)).toBe(true)
      expect(shouldRefreshStatsOn('compaction_end', true)).toBe(true)
    })

    it('drops the per-sub-step polls the stream now covers', () => {
      expect(shouldRefreshStatsOn('message_end', true)).toBe(false)
      expect(shouldRefreshStatsOn('tool_execution_end', true)).toBe(false)
      expect(shouldRefreshStatsOn('message_update', true)).toBe(false)
    })
  })
})

/**
 * Regression: a main-spawned session must enter `live`.
 *
 * Found by driving the real app, not by any test. The orchestrator is spawned
 * in the main process, so the renderer had no `live` entry for it — and
 * `useActiveWorkspace()` resolves the active session's folder through exactly
 * that map. Activating the orchestrator therefore returned null and dropped
 * the whole app to the workspace picker.
 */
describe('adoptSession', () => {
  const invoke = vi.fn()
  const piCommand = vi.fn()

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined)
    piCommand.mockReset().mockResolvedValue({ success: false })
    vi.stubGlobal('window', {
      phosphor: {
        invoke,
        piCommand,
        onSessionPush: () => () => {},
      },
    })
    useSessionsStore.setState({ live: {}, unread: {}, activeSessionId: null })
  })

  it('registers the session so the active workspace resolves', async () => {
    await useSessionsStore.getState().adoptSession('orc-1', '/repo')

    expect(useSessionsStore.getState().live['orc-1']).toMatchObject({
      phosphorId: 'orc-1',
      workspacePath: '/repo',
    })
    useSessionsStore.setState({ activeSessionId: 'orc-1' })
    expect(getActiveWorkspace()).toBe('/repo')
  })

  it('is idempotent, so reopening does not re-subscribe', async () => {
    await useSessionsStore.getState().adoptSession('orc-1', '/repo')
    useSessionsStore.setState((s) => ({ unread: { ...s.unread, 'orc-1': 5 } }))
    await useSessionsStore.getState().adoptSession('orc-1', '/repo')
    expect(useSessionsStore.getState().unread['orc-1']).toBe(5)
  })

  it('records a caller-supplied diskPath, so resume matching works pre-bootstrap', async () => {
    // Reload re-adoption knows the path from the fleet hub; waiting for
    // get_state would let resumeTarget spawn a SECOND process on the file.
    await useSessionsStore.getState().adoptSession('orphan-1', '/repo', '/sessions/s1.jsonl')
    expect(useSessionsStore.getState().live['orphan-1']?.diskPath).toBe('/sessions/s1.jsonl')
  })
})

describe('session scan status', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    vi.stubGlobal('window', {
      phosphor: { invoke, piCommand: vi.fn(), onSessionPush: vi.fn() },
    })
    useSessionsStore.setState({ disk: {}, scanStatus: {} })
  })

  it('records ok and the metas when a single scan succeeds', async () => {
    invoke.mockResolvedValue([meta])
    await useSessionsStore.getState().refreshDisk('/repo')
    const s = useSessionsStore.getState()
    expect(s.scanStatus['/repo']).toBe('ok')
    expect(s.disk['/repo']).toEqual([meta])
  })

  it('records error and never claims the folder is scanned when the scan throws', async () => {
    // Regression: a failed scan used to leave the workspace permanently
    // "unscanned", so the sidebar showed a fake "Loading sessions…" forever.
    invoke.mockRejectedValue(new Error('readdir ENOENT'))
    await useSessionsStore.getState().refreshDisk('/repo')
    const s = useSessionsStore.getState()
    expect(s.scanStatus['/repo']).toBe('error')
    expect(s.disk['/repo']).toBeUndefined()
  })

  it('refreshAllDisk records per-workspace status under mixed success and failure', async () => {
    invoke.mockImplementation((channel: string, path: string) =>
      channel === 'sessions:list' && path === '/repo-ok'
        ? Promise.resolve([])
        : Promise.reject(new Error('boom')),
    )
    await useSessionsStore.getState().refreshAllDisk(['/repo-ok', '/repo-fail'])
    const s = useSessionsStore.getState()
    expect(s.scanStatus['/repo-ok']).toBe('ok')
    expect(s.scanStatus['/repo-fail']).toBe('error')
    expect(s.disk['/repo-ok']).toEqual([])
    expect(s.disk['/repo-fail']).toBeUndefined()
  })

  it('refreshAllDisk caps how many workspaces a cold boot scans', async () => {
    invoke.mockResolvedValue([])
    const paths = Array.from({ length: 12 }, (_, i) => `/w${i}`)
    await useSessionsStore.getState().refreshAllDisk(paths)
    expect(Object.keys(useSessionsStore.getState().scanStatus)).toHaveLength(8)
  })
})

/**
 * The lane-visibility bug: lanes are discovered late and appended last, so the
 * position-capped boot scan skipped them, and the watcher's `ignoreInitial`
 * meant nothing ever backfilled a file already on disk.
 */
describe('refreshMissing', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    vi.stubGlobal('window', {
      phosphor: { invoke, piCommand: vi.fn(), onSessionPush: vi.fn() },
    })
    useSessionsStore.setState({ disk: {}, scanStatus: {} })
  })

  it('scans only the workspaces with no attempt recorded', async () => {
    invoke.mockResolvedValue([])
    useSessionsStore.setState({ scanStatus: { '/repo': 'ok' } })
    await useSessionsStore.getState().refreshMissing(['/repo', '/repo/.phosphor/worktrees/lane'])
    const listed = invoke.mock.calls.filter((c) => c[0] === 'sessions:list').map((c) => c[1])
    expect(listed).toEqual(['/repo/.phosphor/worktrees/lane'])
  })

  it('re-scans a workspace whose last attempt errored only on an explicit retry', async () => {
    invoke.mockResolvedValue([])
    useSessionsStore.setState({ scanStatus: { '/repo': 'error' } })
    await useSessionsStore.getState().refreshMissing(['/repo'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('is not capped — every unscanned lane of an expanded group gets scanned', async () => {
    invoke.mockResolvedValue([])
    const lanes = Array.from({ length: 20 }, (_, i) => `/repo/.phosphor/worktrees/l${i}`)
    await useSessionsStore.getState().refreshMissing(lanes)
    expect(invoke.mock.calls.filter((c) => c[0] === 'sessions:list')).toHaveLength(20)
  })

  it('settles after one pass, so an effect keyed on the groups cannot loop', async () => {
    invoke.mockResolvedValue([])
    await useSessionsStore.getState().refreshMissing(['/a'])
    invoke.mockClear()
    await useSessionsStore.getState().refreshMissing(['/a'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does nothing at all when there is nothing missing', async () => {
    useSessionsStore.setState({ scanStatus: { '/a': 'ok' } })
    await useSessionsStore.getState().refreshMissing(['/a'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('deduplicates repeated paths', async () => {
    invoke.mockResolvedValue([])
    await useSessionsStore.getState().refreshMissing(['/a', '/a', '/a'])
    expect(invoke.mock.calls.filter((c) => c[0] === 'sessions:list')).toHaveLength(1)
  })
})
