import { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcessModule from 'node:child_process'
import type { ClaudeLoginState, ClaudeStatus } from '@shared/models'
import { shell } from 'electron'
import { claudeStatus, resolveBinary } from './packages'
import { piProcessEnv } from './shell-env'
import {
  cancelClaudeLogin,
  claudeLoginInFlight,
  startClaudeLogin,
  submitClaudeLoginCode,
} from './claude-login'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: vi.fn(),
}))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./packages', () => ({ claudeStatus: vi.fn(), resolveBinary: vi.fn() }))
vi.mock('./shell-env', () => ({ piProcessEnv: vi.fn() }))

const FIRST_URL = 'https://claude.com/oauth/authorize?state=first'
const NEXT_URL = 'https://claude.com/oauth/authorize?state=next'
const status = (email = 'old@example.com'): ClaudeStatus => ({
  binary: { found: true },
  auth: { ok: true, loggedIn: true, email },
})

let child: ChildProcess
let stdout: PassThrough
let stderr: PassThrough
let states: ClaudeLoginState[]

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  child = new ChildProcess()
  child.stdin = new PassThrough()
  child.stdout = stdout = new PassThrough()
  child.stderr = stderr = new PassThrough()
  vi.spyOn(child, 'kill').mockReturnValue(true)
  vi.mocked(spawn).mockReturnValue(child)
  vi.mocked(resolveBinary).mockResolvedValue('/bin/claude')
  vi.mocked(piProcessEnv).mockResolvedValue({ PATH: '/bin', KEEP: 'shell' })
  vi.mocked(claudeStatus).mockResolvedValue(status())
  states = []
})

afterEach(() => {
  cancelClaudeLogin()
  vi.useRealTimers()
})

const start = (): Promise<void> => startClaudeLogin((state) => states.push(state))

describe('Claude login lifecycle through the public entry', () => {
  it('leaves browser opening to the CLI and reports its fallback URL', async () => {
    await start()
    stdout.emit('data', Buffer.from(`Opening browser…\nvisit: ${FIRST_URL}\n`))
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(states).toEqual([
      { phase: 'starting' },
      { phase: 'awaiting-code', url: FIRST_URL, invalidCode: false },
    ])
  })

  it('uses the newest URL after invalid code and restarts the browser budget', async () => {
    await start()
    stdout.emit('data', Buffer.from(`visit: ${FIRST_URL}\n`))
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    submitClaudeLoginCode(' bad-code ')
    stderr.emit('data', Buffer.from(`Invalid code.\nvisit: ${NEXT_URL}\n`))
    expect(states.slice(-2)).toEqual([
      { phase: 'finishing' },
      { phase: 'awaiting-code', url: NEXT_URL, invalidCode: true },
    ])
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(states.at(-1)).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('browser'),
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('does not accept the old identity after an invalid code even on exit zero', async () => {
    await start()
    stdout.emit('data', Buffer.from('Invalid code.\nLogin successful.\n'))
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toEqual({
      phase: 'error',
      message: 'That code was not accepted. Try signing in again.',
    })
    expect(claudeLoginInFlight()).toBe(false)
  })

  it('kills on URL timeout and settles once despite later exit and error', async () => {
    await start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(states.at(-1)).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('link'),
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    child.emit('error', new Error('late'))
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(states).toHaveLength(2)
    expect(claudeStatus).toHaveBeenCalledTimes(1)
    expect(claudeLoginInFlight()).toBe(false)
  })

  it('cancels once, kills, clears timers and releases admission before notifying', async () => {
    const inFlight: boolean[] = []
    await startClaudeLogin((state) => {
      states.push(state)
      inFlight.push(claudeLoginInFlight())
    })
    cancelClaudeLogin()
    cancelClaudeLogin()
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(states).toEqual([{ phase: 'starting' }, { phase: 'cancelled' }])
    expect(inFlight).toEqual([true, false])
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves credential environment for spawn and both status probes', async () => {
    const extraEnv = { CLAUDE_CONFIG_DIR: '/account', KEEP: 'account' }
    await startClaudeLogin((state) => states.push(state), '/custom/claude', extraEnv)
    expect(spawn).toHaveBeenCalledWith('/custom/claude', ['auth', 'login'], {
      cwd: expect.any(String),
      env: { PATH: '/bin', KEEP: 'account', CLAUDE_CONFIG_DIR: '/account' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    vi.mocked(claudeStatus).mockResolvedValueOnce(status('new@example.com'))
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(claudeStatus).toHaveBeenNthCalledWith(1, '/custom/claude', extraEnv)
    expect(claudeStatus).toHaveBeenNthCalledWith(2, '/custom/claude', extraEnv)
    expect(states.at(-1)).toEqual({ phase: 'signed-in', email: 'new@example.com' })
  })

  it('spawns before baseline status and binds callbacks only after that status resolves', async () => {
    let resolveStatus: (value: ClaudeStatus) => void = () => {}
    vi.mocked(claudeStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
    )
    const starting = start()
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(claudeStatus).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('exit')).toBe(0)
    expect(states).toEqual([])
    expect(claudeLoginInFlight()).toBe(false)
    resolveStatus(status())
    await starting
    expect(child.listenerCount('exit')).toBe(1)
    expect(states).toEqual([{ phase: 'starting' }])
  })
})
