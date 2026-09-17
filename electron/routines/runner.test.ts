import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { newRoutine, type RoutineRun } from '@shared/routines'
import { executeRoutine } from './runner'
import { observeRoutineSession, isRoutineSession } from './ownership'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  lane: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  dispose: vi.fn(),
  gitInfo: vi.fn(),
  broadcast: vi.fn(),
  bind: vi.fn(),
}))
vi.mock('../pi/session-runtime', () => ({ spawnSession: h.spawn }))
vi.mock('../registry', () => ({ registry: { get: h.get, list: h.list, dispose: h.dispose } }))
vi.mock('../fs/lane-workspace', () => ({ createLaneWorkspace: h.lane }))
vi.mock('../fs/git-exec', () => ({ git: vi.fn(async () => 'abc123') }))
vi.mock('../fs/git-info', () => ({ gitInfo: h.gitInfo }))
vi.mock('../claude/accounts', () => ({ bindSession: h.bind }))
vi.mock('../pi/session-accounts', () => ({
  spawnAccountFor: () => 'account',
  forgetSpawnAccount: vi.fn(),
}))
vi.mock('../pi/provider-detect', () => ({ assertClaudeContextProvider: vi.fn() }))
vi.mock('../pi/packages', () => ({ listPackages: vi.fn() }))
vi.mock('../pi/stub', () => ({ piStubPath: () => '/stub' }))
vi.mock('../broadcast', () => ({ broadcast: h.broadcast }))

let directory: string
let run: RoutineRun
let events: EventEmitter
let request: Mock<
  (command: { type: string }) => Promise<{
    success: boolean
    data?: { model: { provider: string; id: string }; sessionFile?: string }
  }>
>
beforeEach(() => {
  vi.clearAllMocks()
  directory = mkdtempSync(join(tmpdir(), 'routine-runner-'))
  run = {
    id: 'run',
    routineId: 'routine',
    trigger: 'manual',
    scheduledAt: Date.now(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    reason: '',
    definition: {
      ...newRoutine(directory),
      provider: 'test',
      model: 'model',
      name: 'Test',
      instructions: 'Report.',
      trusted: true,
      id: 'routine',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextAt: null,
      attention: null,
      archived: false,
    },
    sessionId: null,
    sessionPath: null,
    workspacePath: null,
    branch: null,
    baseCommit: null,
    accountId: null,
    summary: '',
  }
  events = new EventEmitter()
  request = vi.fn(async (command: { type: string }) => {
    if (command.type === 'prompt')
      queueMicrotask(() =>
        events.emit('event', {
          type: 'agent_end',
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'Report.' }], stopReason: 'stop' },
          ],
        }),
      )
    return {
      success: true,
      data:
        command.type === 'get_state'
          ? { model: { provider: 'test', id: 'model' }, sessionFile: '/session.jsonl' }
          : undefined,
    }
  })
  h.get.mockReturnValue({ client: { on: events.on.bind(events), request, alive: true } })
  h.list.mockReturnValue([])
  h.spawn.mockResolvedValue({ sessionId: 'session' })
  h.lane.mockResolvedValue({ workspacePath: directory, branch: 'routine/test' })
  h.gitInfo.mockResolvedValue({ isRepo: false })
  h.dispose.mockResolvedValue(undefined)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('window-independent routine execution', () => {
  it('attaches a normal session, records metadata, and disposes an unobserved run', async () => {
    const progress = vi.fn()
    const result = await executeRoutine(run, new AbortController().signal, progress)
    expect(result.status).toBe('finished')
    expect(h.spawn.mock.calls[0]?.[1]).toBeUndefined()
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'routine/test', baseCommit: 'abc123' }),
    )
    expect(progress).toHaveBeenCalledWith({ sessionPath: '/session.jsonl' })
    expect(h.bind).toHaveBeenCalledWith('/session.jsonl', 'account')
    expect(request).toHaveBeenCalledWith({ type: 'set_auto_retry', enabled: false })
    expect(h.dispose).toHaveBeenCalledWith('session')
    expect(isRoutineSession('session')).toBe(false)
  })
  it('never falls back into the main checkout after an isolation failure', async () => {
    h.lane.mockResolvedValue({ workspacePath: directory, warning: 'git refused' })
    expect((await executeRoutine(run, new AbortController().signal, () => {})).status).toBe(
      'blocked',
    )
    expect(h.spawn).not.toHaveBeenCalled()
  })
  it('refuses model substitution before sending a prompt', async () => {
    request.mockResolvedValue({
      success: true,
      data: { model: { provider: 'test', id: 'other-model' } },
    })
    const result = await executeRoutine(run, new AbortController().signal, () => {})
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('exactly')
    expect(request.mock.calls.some(([c]) => c.type === 'prompt')).toBe(false)
  })
  it('aborts a hung bootstrap request instead of waiting forever', async () => {
    request.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const result = executeRoutine(run, controller.signal, () => {})
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    controller.abort()
    expect((await result).status).toBe('cancelled')
    expect(h.dispose).toHaveBeenCalledWith('session')
  })
  it('blocks unexpected dialogs without answering them', async () => {
    request.mockImplementation(async (command: { type: string }) => {
      if (command.type === 'get_state') {
        queueMicrotask(() =>
          events.emit('extension-ui', { method: 'input', title: 'Authenticate' }),
        )
        return new Promise(() => {})
      }
      return { success: true }
    })
    const result = await executeRoutine(run, new AbortController().signal, () => {})
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('No prompt was auto-answered')
    expect(h.dispose).toHaveBeenCalledWith('session')
  })
  it('preserves an explicitly opened successful lane for interactive follow-up', async () => {
    const original = request.getMockImplementation()!
    request.mockImplementation(async (command: { type: string }) => {
      if (command.type === 'prompt') observeRoutineSession('session')
      return original(command)
    })
    expect((await executeRoutine(run, new AbortController().signal, () => {})).status).toBe(
      'finished',
    )
    expect(h.dispose).not.toHaveBeenCalled()
    expect(isRoutineSession('session')).toBe(false)
  })
  it('does not run a non-isolated task in a folder with another live session', async () => {
    run.definition.isolated = false
    h.list.mockReturnValue([{ workspacePath: directory }])
    const result = await executeRoutine(run, new AbortController().signal, () => {})
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('in use')
    expect(h.spawn).not.toHaveBeenCalled()
  })
  it('does not let a non-isolated code task write over uncommitted work', async () => {
    run.definition.isolated = false
    h.gitInfo.mockResolvedValue({ isRepo: true, dirtyCount: 6 })
    const result = await executeRoutine(run, new AbortController().signal, () => {})
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('6 uncommitted changes')
    expect(h.spawn).not.toHaveBeenCalled()
  })
  it('runs a non-isolated report against the dirty tree it was pointed at', async () => {
    run.definition.isolated = false
    run.definition.intent = 'report'
    h.gitInfo.mockResolvedValue({ isRepo: true, dirtyCount: 6 })
    const progress = vi.fn()
    expect((await executeRoutine(run, new AbortController().signal, progress)).status).toBe(
      'finished',
    )
    expect(progress).toHaveBeenCalledWith({ workspacePath: realpathSync.native(directory) })
  })
})
