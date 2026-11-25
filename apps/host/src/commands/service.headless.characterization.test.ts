import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { serviceUnit } from '../machine/systemd'
import { launchAgentPlist } from '../machine/launchd'

it('keeps both headless service descriptions byte-identical', () => {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const args = ['/fixture/node', '/fixture/bundle', '/fixture/config', '/fixture/bin'] as const
  expect([digest(serviceUnit(...args)), digest(launchAgentPlist(...args, '/fixture/logs'))])
    .toMatchInlineSnapshot(`
    [
      "b1640b789927ab731626ec74447b94bc33f9692b518912a8d70a9e72fcd043d5",
      "b9b6e50f2751af9d58e70bfa4e264ea7883a448470d30529601a8781b8d42383",
    ]
  `)
})
