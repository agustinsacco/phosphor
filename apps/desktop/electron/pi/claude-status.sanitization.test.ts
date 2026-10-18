import { beforeEach, expect, it, vi } from 'vitest'
import { claudeStatus } from './claude-status'

const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))
vi.mock('node:util', () => ({ promisify: () => exec }))
vi.mock('./binary-lookup', () => ({ resolveBinary: vi.fn() }))
vi.mock('./shell-env', () => ({ piProcessEnv: async () => ({ PATH: '/shell' }) }))

beforeEach(() => {
  vi.resetAllMocks()
  exec.mockResolvedValueOnce({ stdout: '2.1.0' })
})

it.each(['success', 'failure'])('does not project raw account auth output on %s', async (exit) => {
  const stdout = 'HOST_PRIVATE_AUTH_OUTPUT'
  if (exit === 'success') exec.mockResolvedValueOnce({ stdout })
  else exec.mockRejectedValueOnce({ stdout, message: 'exit 1' })

  const result = await claudeStatus('/claude', {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/private-account',
  })

  expect(result.auth).toEqual({ ok: false, error: 'no auth status' })
  expect(JSON.stringify(result)).not.toContain(stdout)
})
