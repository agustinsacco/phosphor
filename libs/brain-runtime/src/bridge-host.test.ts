import { expect, it, vi } from 'vitest'
import { createBrainClient } from '@phosphor/brain-client/client'
import { createNodeBrainTransport } from '@phosphor/brain-client/node-transport'
import { createBrainBridge } from './bridge'

it('isolates the Host capability from all lane and curator methods', async ({ onTestFinished }) => {
  const invoke = vi.fn(async () => null)
  const bridge = await createBrainBridge(invoke, { host: async () => ({ enabled: true }) } as never)
  onTestFinished(() => bridge.close())
  const reg = bridge.registration(true) as ReturnType<typeof bridge.registration> & {
    opsToken: string
  }
  const transport = createNodeBrainTransport({ endpoint: reg.endpoint, token: reg.opsToken })
  await expect(createBrainClient(transport).search({ query: 'a' })).rejects.toThrow('unavailable')
  await expect(transport.request('flag', {} as never)).rejects.toThrow('unavailable')
  await expect(transport.request('erase', {} as never)).rejects.toThrow('unavailable')
  expect(invoke).not.toHaveBeenCalled()
})
