import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeLoginState, ClaudeStatus } from '@shared/models'
import {
  cancelLoginAttempt,
  createLoginAttempt,
  emitLoginState,
  submitLoginCode,
  type LoginAttempt,
} from './claude-login-attempt'

const URL = 'https://claude.com/oauth?state=one'
const NEXT_URL = 'https://claude.com/oauth?state=two'
const signedIn: ClaudeStatus = {
  binary: { found: true },
  auth: { ok: true, loggedIn: true, email: 'new@example.com' },
}

let child: ChildProcess
let stdout: PassThrough
let stderr: PassThrough
let states: ClaudeLoginState[]
let attempt: LoginAttempt
const onSettled = vi.fn()
const getStatus = vi.fn<() => Promise<ClaudeStatus>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  child = new ChildProcess()
  child.stdin = new PassThrough()
  child.stdout = stdout = new PassThrough()
  child.stderr = stderr = new PassThrough()
  vi.spyOn(child, 'kill').mockReturnValue(true)
  getStatus.mockResolvedValue(signedIn)
  states = []
  attempt = createLoginAttempt({
    child,
    emailBefore: 'old@example.com',
    onState: (state) => states.push(state),
    onSettled,
    getStatus,
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Claude login attempt', () => {
  it('combines stdout and stderr chunks and suppresses repeated URL notifications', () => {
    stdout.emit('data', Buffer.from('vis'))
    expect(states).toEqual([])
    stderr.emit('data', Buffer.from(`it: ${URL}\n`))
    stdout.emit('data', Buffer.from('Paste code here > '))
    expect(states).toEqual([{ phase: 'awaiting-code', url: URL, invalidCode: false }])
    expect(attempt.output).toBe(`visit: ${URL}\nPaste code here > `)
    expect(attempt.lastUrl).toBe(URL)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('emits finishing before writing trimmed code and re-prompts on the same rejected URL', () => {
    stdout.emit('data', Buffer.from(`visit: ${URL}\n`))
    const write = vi.spyOn(child.stdin!, 'write').mockImplementation(() => {
      expect(states.at(-1)).toEqual({ phase: 'finishing' })
      return true
    })
    submitLoginCode(attempt, '  code\n ')
    expect(write).toHaveBeenCalledWith('code\n')
    expect(attempt.awaitingExit).toBe(true)
    stderr.emit('data', Buffer.from('Invalid code.\n'))
    expect(attempt.awaitingExit).toBe(false)
    expect(states.at(-1)).toEqual({ phase: 'awaiting-code', url: URL, invalidCode: true })
    stderr.emit('data', Buffer.from('Paste code here > '))
    expect(states).toHaveLength(3)
  })

  it('restarts the flow timer on a new URL and clears the URL deadline', async () => {
    await vi.advanceTimersByTimeAsync(29_000)
    stdout.emit('data', Buffer.from(`visit: ${URL}\n`))
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    stderr.emit('data', Buffer.from(`Invalid code.\nvisit: ${NEXT_URL}\n`))
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(states.at(-1)).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('browser'),
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(attempt.settled).toBe(true)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles before terminal notification and ignores later states', () => {
    const onState = vi.fn(() => {
      expect(attempt.settled).toBe(true)
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })
    attempt.onState = onState
    cancelLoginAttempt(attempt)
    emitLoginState(attempt, { phase: 'signed-in', email: 'late@example.com' })
    child.emit('error', new Error('late error'))
    child.emit('exit', 0)
    expect(onState).toHaveBeenCalledExactlyOnceWith({ phase: 'cancelled' })
    expect(getStatus).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('waits for asynchronous status verification instead of trusting exit or prose', async () => {
    let resolveStatus: (status: ClaudeStatus) => void = () => {}
    getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
    )
    stdout.emit('data', Buffer.from('Login successful.\n'))
    child.emit('exit', 0)
    expect(states).toEqual([])
    expect(attempt.settled).toBe(false)
    resolveStatus(signedIn)
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual([{ phase: 'signed-in', email: 'new@example.com' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a verification result arriving after cancellation', async () => {
    let resolveStatus: (status: ClaudeStatus) => void = () => {}
    getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
    )
    child.emit('exit', 0)
    cancelLoginAttempt(attempt)
    resolveStatus(signedIn)
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual([{ phase: 'cancelled' }])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('still accepts a changed identity after rejection', async () => {
    stdout.emit('data', Buffer.from('Invalid code.\n'))
    child.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual([{ phase: 'signed-in', email: 'new@example.com' }])
  })

  it.each([
    ['', 'Sign-in did not complete.'],
    ['first\n  useful failure  \n', 'useful failure'],
    ['x'.repeat(250), 'x'.repeat(200)],
    ['Invalid code.\nLogin successful.', 'That code was not accepted. Try signing in again.'],
  ])('reports the useful failed-run message from %j', async (output, message) => {
    getStatus.mockResolvedValueOnce({
      binary: { found: true },
      auth: { ok: true, loggedIn: false },
    })
    stdout.emit('data', Buffer.from(output))
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual([{ phase: 'error', message }])
  })

  it.each([new Error('status failed'), 'status failed'])(
    'reports status verification rejection %j',
    async (error) => {
      getStatus.mockRejectedValueOnce(error)
      child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(0)
      expect(states).toEqual([{ phase: 'error', message: 'status failed' }])
    },
  )

  it('reports process errors and clears both deadlines without killing', () => {
    child.emit('error', new Error('spawn failed'))
    expect(states).toEqual([{ phase: 'error', message: 'spawn failed' }])
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out a missing URL and kills only after notifying', async () => {
    attempt.onState = (state) => {
      expect(child.kill).not.toHaveBeenCalled()
      states.push(state)
    }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(states).toEqual([
      {
        phase: 'error',
        message:
          'The Claude CLI did not offer a sign-in link. Try `claude auth login` in a terminal.',
      },
    ])
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
