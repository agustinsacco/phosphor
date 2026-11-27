import { afterEach, expect, it } from 'vitest'
import { startLineProcess, stopAll } from './__fixtures__/line-process'

afterEach(stopAll)

it('starts a Host fixture larger than the OS command-line limit', async () => {
  const source = `/*${'x'.repeat(2 * 1024 * 1024)}*/\nconsole.log(JSON.stringify({ ready: true }))`
  expect(await startLineProcess(source, []).next()).toEqual({ ready: true })
})
