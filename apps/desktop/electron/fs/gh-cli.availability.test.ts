import { beforeEach, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execute }))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: async () => ({ PATH: '/tools' }) }))

beforeEach(() => {
  vi.resetModules()
  execute.mockReset()
})

it('retries a failed availability probe, coalesces concurrent probes, and caches success', async () => {
  execute.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, done: (error: Error) => void) =>
      done(new Error('gh is not installed yet')),
  )
  const { ghAvailable } = await import('./gh-cli')
  expect(await ghAvailable()).toBe(false)
  execute.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      done: (error: null, output: string) => void,
    ) => done(null, 'gh version'),
  )
  expect(await Promise.all([ghAvailable(), ghAvailable()])).toEqual([true, true])
  expect(await ghAvailable()).toBe(true)
  expect(execute).toHaveBeenCalledTimes(2)
})
