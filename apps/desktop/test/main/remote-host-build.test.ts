import { expect, it, vi } from 'vitest'
import { createHostFixtureBuilder } from '../../e2e/fixtures/remote-host-build'

it('rebuilds every mode transition, including native after a plain rebuild', async () => {
  const build = vi.fn<(native?: string) => void>()
  const native = vi.fn(async (run: (directory: string) => void) => run('/native'))
  const ensure = createHostFixtureBuilder({ build, native })
  await ensure(true)
  await ensure(true)
  await ensure(false)
  await ensure(false)
  await ensure(true)
  expect(build.mock.calls).toEqual([['/native'], [], ['/native']])
  expect(native).toHaveBeenCalledTimes(2)
})

it('does not cache a failed build', async () => {
  const build = vi.fn<(native?: string) => void>().mockImplementationOnce(() => {
    throw new Error('build failed')
  })
  const ensure = createHostFixtureBuilder({
    build,
    native: async (run) => run('/native'),
  })
  await expect(ensure()).rejects.toThrow('build failed')
  await ensure()
  expect(build).toHaveBeenCalledTimes(2)
})
