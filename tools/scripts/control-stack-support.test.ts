import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { localStack, startFake } from './control-stack-support.mjs'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
const answer = (stdout: string, status = 0) => ({
  pid: 1,
  output: [],
  stdout,
  stderr: '',
  status,
  signal: null,
})
afterEach(() => vi.resetAllMocks())
it('refuses a running fake without removing it', async () => {
  vi.mocked(spawnSync).mockReturnValue(answer('true\n'))
  await expect(startFake(new AbortController().signal, true)).rejects.toThrow('already running')
  expect(spawnSync).toHaveBeenCalledTimes(1)
  expect(spawnSync).toHaveBeenCalledWith(
    'docker',
    ['inspect', '--format', '{{.State.Running}}', 'phosphor-control-test-fake-github'],
    expect.anything(),
  )
})
it('reads only the isolated local stack without printing development keys', () => {
  const secret = 'sb_secret_' + randomBytes(32).toString('hex')
  const publicKey = randomBytes(32).toString('hex')
  vi.mocked(spawnSync).mockReturnValue(
    answer(
      `API_URL="http://127.0.0.1:54351"\nPUBLISHABLE_KEY="${publicKey}"\nSECRET_KEY="${secret}"`,
    ),
  )
  const log = vi.spyOn(console, 'log')
  const result = localStack()
  expect(result.url).toBe('http://127.0.0.1:54351')
  expect(result.secret === secret && result.key === publicKey).toBe(true)
  expect(log).not.toHaveBeenCalled()
  for (const url of ['http://192.0.2.1:54351', 'http://127.0.0.1:9999']) {
    vi.mocked(spawnSync).mockReturnValue(
      answer(`API_URL="${url}"\nPUBLISHABLE_KEY="${publicKey}"\nSECRET_KEY="${secret}"`),
    )
    expect(() => localStack()).toThrow('Refusing')
  }
  log.mockRestore()
})
it('does not propagate command diagnostics containing keys', () => {
  const secret = randomBytes(32).toString('hex')
  vi.mocked(spawnSync).mockReturnValue({ ...answer('', 1), stderr: secret })
  expect(() => localStack()).toThrow(/^npx --yes supabase@2\.119\.0 failed$/)
})
