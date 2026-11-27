import { expect, it } from 'vitest'
import { createHarness, local, machine } from './__fixtures__/dispatcher-harness'

const install = { op: 'claude.installCli', args: {}, reason: 'test' }

it('tells a routed caller to come back with the same --host', async () => {
  const h = createHarness({ jobs: true })
  const routed = await h.run(machine(), install)
  expect(routed).toMatchObject({
    status: 'ok',
    text: 'Started: Install the Claude CLI. Check it with: phosphor job status job-1 (with the same --host)',
  })
  const here = await h.run(local(), install)
  expect(here).toMatchObject({
    status: 'ok',
    text: 'Started: Install the Claude CLI. Check it with: phosphor job status job-2',
  })
})
