import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LoginFlowState } from '@shared/models'
import type { AuthCheck } from '@phosphor/session-runtime/pi/provider-auth'
import { checkProviderAuth } from './auth-status'
import { ptyManager } from '../pty/pty-manager'
import { startLoginDriver } from './login-driver'

vi.mock('./auth-status', () => ({ checkProviderAuth: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../pty/pty-manager', () => ({
  ptyManager: { attach: vi.fn(), write: vi.fn(), kill: vi.fn() },
}))

let screen = ''
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  vi.resetAllMocks()
  screen = ''
  vi.mocked(ptyManager.attach).mockImplementation(() => ({ scrollback: screen }))
  vi.mocked(checkProviderAuth).mockResolvedValue({ status: 'not_ready' })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function setup(before: AuthCheck = { status: 'not_ready' }) {
  const states: LoginFlowState[] = []
  const onFinish = vi.fn(() => {
    expect(ptyManager.kill).not.toHaveBeenCalled()
  })
  const handle = startLoginDriver({
    providerId: 'xai',
    label: 'xAI',
    ptyId: 'pty',
    before,
    onState: (state) => states.push(state),
    onFinish,
  })
  return { handle, states, onFinish }
}
async function paint(text: string, delay = 250): Promise<void> {
  screen = text
  await vi.advanceTimersByTimeAsync(delay)
}
async function browser(): Promise<void> {
  await paint('›')
  await paint('https://example.com/device\nEnter code: CODE-1234')
}

it('waits for each screen, filters the provider and answers the host question once', async () => {
  setup()
  await paint('loading')
  expect(ptyManager.write).not.toHaveBeenCalled()
  await paint('›')
  await paint('Select authentication method:')
  await paint('Select provider to configure:')
  await vi.advanceTimersByTimeAsync(399)
  expect(ptyManager.write).toHaveBeenLastCalledWith('pty', 'xAI')
  await vi.advanceTimersByTimeAsync(1)
  await paint('GitHub Enterprise URL/domain')
  await paint('GitHub Enterprise URL/domain')
  expect(vi.mocked(ptyManager.write).mock.calls.map((call) => call[1])).toEqual([
    '/login\r',
    '\r',
    'xAI',
    '\r',
    '\r',
  ])
})

it('emits a URL once, then emits again when its code changes', async () => {
  const { states } = setup()
  await browser()
  await vi.advanceTimersByTimeAsync(1000)
  expect(states).toEqual([
    {
      providerId: 'xai',
      phase: 'awaiting-browser',
      url: 'https://example.com/device',
      userCode: 'CODE-1234',
    },
  ])
  await paint('https://example.com/device\nEnter code: NEXT-5678')
  expect(states).toHaveLength(2)
  expect(states[1]).toEqual({
    providerId: 'xai',
    phase: 'awaiting-browser',
    url: 'https://example.com/device',
    userCode: 'NEXT-5678',
  })
})

it('accepts a first credential and releases ownership before killing the PTY', async () => {
  const { states, onFinish, handle } = setup()
  vi.mocked(checkProviderAuth).mockResolvedValue({ status: 'ready', fingerprint: 'first' })
  await browser()
  expect(states.at(-1)).toEqual({ providerId: 'xai', phase: 'signed-in' })
  expect(onFinish).toHaveBeenCalledOnce()
  expect(ptyManager.kill).toHaveBeenCalledExactlyOnceWith('pty')
  handle.cancel()
  await vi.advanceTimersByTimeAsync(5000)
  expect(checkProviderAuth).toHaveBeenCalledOnce()
  expect(onFinish).toHaveBeenCalledOnce()
})

it('retains an existing credential until verification sees a replacement', async () => {
  const { states } = setup({ status: 'ready', fingerprint: 'old' })
  vi.mocked(checkProviderAuth).mockResolvedValue({ status: 'ready', fingerprint: 'old' })
  await browser()
  await vi.advanceTimersByTimeAsync(1750)
  expect(checkProviderAuth).toHaveBeenCalledOnce()
  expect(ptyManager.kill).not.toHaveBeenCalled()
  vi.mocked(checkProviderAuth).mockResolvedValue({ status: 'ready', fingerprint: 'new' })
  await vi.advanceTimersByTimeAsync(250)
  expect(states.at(-1)?.phase).toBe('signed-in')
})

it('cancels before killing and ignores pending verification results', async () => {
  const { states, handle, onFinish } = setup()
  let resolve!: (value: AuthCheck) => void
  vi.mocked(checkProviderAuth).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  await browser()
  await vi.advanceTimersByTimeAsync(5000)
  expect(checkProviderAuth).toHaveBeenCalledOnce()
  handle.cancel()
  expect(ptyManager.write).toHaveBeenLastCalledWith('pty', '\u001b')
  expect(ptyManager.write).toHaveBeenCalledBefore(vi.mocked(ptyManager.kill))
  resolve({ status: 'ready' })
  await vi.advanceTimersByTimeAsync(250)
  expect(states.at(-1)).toEqual({ providerId: 'xai', phase: 'cancelled' })
  expect(onFinish).toHaveBeenCalledOnce()
})

it('times out an unrecognized step and clears its polling timer', async () => {
  const { states, onFinish } = setup()
  await paint('startup dialog', 20_000)
  expect(states).toEqual([])
  await vi.advanceTimersByTimeAsync(250)
  expect(states.at(-1)).toEqual({
    providerId: 'xai',
    phase: 'error',
    message: expect.stringContaining('stopped at a screen'),
  })
  expect(onFinish).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
