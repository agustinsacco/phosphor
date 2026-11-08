import { mockTraffic } from './mockTraffic'

/** Connection-only Host calls, including transfers the mock cannot perform. */
export function mockHostConnectionInvoke(channel: string, args: unknown[]): unknown {
  switch (channel) {
    case 'hosts:tailscaleStatus':
      return { code: 'not-installed' }
    case 'hosts:traffic':
      return mockTraffic(Number(args[0]) || 0)
    case 'hosts:reconnect':
      return undefined
    case 'hosts:providerLogin':
      throw new Error('Provider sign-in needs a connected Host.')
    case 'hosts:uploadAttachments':
      throw new Error('Attachment uploads require a live Host.')
    default:
      throw new Error(
        'Moving lanes needs Desktop and real workspaces; it is unavailable in the mock.',
      )
  }
}
