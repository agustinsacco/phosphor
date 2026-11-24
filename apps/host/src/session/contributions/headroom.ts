import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import type { DaemonHeadroom } from '../headroom'

export function createHeadroomContribution(headroom?: DaemonHeadroom): SpawnContribution | null {
  return headroom
    ? {
        name: 'headroom',
        spawn() {
          const path = headroom.socket()
          return path ? { env: { PHOSPHOR_HEADROOM_SOCKET: path } } : undefined
        },
      }
    : null
}
