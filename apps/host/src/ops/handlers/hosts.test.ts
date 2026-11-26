import { describe, expect, it } from 'vitest'
import type { ReachDirectory } from '@phosphor/session-runtime/ops/reach'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { DIRECTORY_REFUSALS } from '../../reach'
import { hostsHandlers } from './hosts'

const ctx = { principal: { kind: 'local', clientId: 'cli' } } as unknown as OpHandlerContext
const SELF = 'aaaaaaaa-0000-4000-8000-00000000000a'

const list = (directory?: () => Promise<ReachDirectory>) =>
  hostsHandlers(directory ? { directory } : {})['hosts.list']!({}, ctx)

describe('hosts.list', () => {
  it('lists this machine first, then each machine with its state and why it is not ready', async () => {
    const directory: ReachDirectory = {
      available: true,
      self: { id: SELF, label: 'This Mac' },
      machines: [
        {
          id: 'b1b1b1b1-0',
          label: 'bee1',
          online: true,
          hostVersion: '0.3.0',
          ready: true,
        },
        {
          id: 'b2b2b2b2-0',
          label: 'bee2',
          online: false,
          hostVersion: null,
          ready: false,
          why: 'offline',
        },
        {
          id: 'b3b3b3b3-0',
          label: 'bee3',
          online: true,
          hostVersion: '0.2.80',
          ready: false,
          why: 'not-enrolled',
        },
        {
          id: 'b4b4b4b4-0',
          label: 'bee4',
          online: true,
          hostVersion: '0.3.0',
          ready: false,
          why: 'offline',
        },
        { id: SELF, label: 'This Mac', online: true, hostVersion: '0.3.0', ready: true },
      ],
    }
    const out = await list(async () => directory)
    expect(out.text).toBe(
      [
        'This machine: This Mac (aaaaaaaa)',
        'bee1 (b1b1b1b1): online, Host 0.3.0, ready',
        'bee2 (b2b2b2b2): offline, version unknown, not ready: offline',
        'bee3 (b3b3b3b3): online, Host 0.2.80, not ready: not enrolled for reach',
        'bee4 (b4b4b4b4): online, Host 0.3.0, not ready: unreachable on your tailnet',
      ].join('\n'),
    )
    expect(out.data).toBe(directory)
  })

  it('says when there is nothing to list or no directory at all', async () => {
    const empty: ReachDirectory = {
      available: true,
      self: { id: SELF, label: 'This Mac' },
      machines: [],
    }
    expect((await list(async () => empty)).text).toBe(
      'This machine: This Mac (aaaaaaaa)\nNo other machines on your account.',
    )
    await expect(list(async () => ({ available: false, reason: 'reach-off' }))).rejects.toMatchObject({
      message: DIRECTORY_REFUSALS['reach-off'].message,
    })
    await expect(list()).rejects.toMatchObject({ code: 'unsupported' })
  })
})
