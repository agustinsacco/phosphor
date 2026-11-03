import { afterEach, expect, it, vi } from 'vitest'
const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: exec }))
import { runGithubCommand } from './github-command'

afterEach(() => vi.clearAllMocks())
const run = () =>
  runGithubCommand(
    '/repo',
    ['api', 'graphql'],
    { PATH: '/login/bin' },
    new AbortController().signal,
  )

it('keeps gh in the supplied machine environment and bounds the subprocess', async () => {
  exec.mockImplementation((_file, _args, _opts, cb) =>
    cb(null, {
      stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"data":{}}',
      stderr: '',
    }),
  )
  expect(await run()).toEqual({ ok: true, stdout: '{"data":{}}' })
  expect(exec.mock.calls[0]?.[2]).toMatchObject({
    cwd: '/repo',
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/login/bin', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  })
  expect(exec.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal)
})

it('retains a rate-limit retry budget but never exposes stderr', async () => {
  exec.mockImplementation((_file, _args, _opts, cb) =>
    cb(
      Object.assign(new Error('failed'), {
        stdout: 'HTTP/2.0 429\r\nRetry-After: 180\r\n',
        stderr: 'secret-token rate limit exceeded',
      }),
    ),
  )
  expect(await run()).toEqual({ ok: false, reason: 'rate-limited', retryAfterMs: 180000 })
})

it('only resource failures request the lighter detail retry', async () => {
  exec.mockImplementation((_file, _args, _opts, cb) =>
    cb(
      Object.assign(new Error('failed'), {
        stderr: 'GraphQL: Resource limits for this query exceeded',
      }),
    ),
  )
  expect(await run()).toMatchObject({ reason: 'unavailable', retryWithoutChecks: true })
  exec.mockImplementation((_file, _args, _opts, cb) =>
    cb(Object.assign(new Error('failed'), { stderr: 'authentication required' })),
  )
  expect(await run()).toMatchObject({ reason: 'unavailable', retryWithoutChecks: false })
})
