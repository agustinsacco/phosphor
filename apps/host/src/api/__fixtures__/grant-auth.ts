import type { KeyObject } from 'node:crypto'
import type { GrantPayload } from '@phosphor/shared/host-grant'
import type { HostHello } from '@phosphor/shared/remote-host'
import type { Authority } from '../authority'
import { createGrantAuth, type GrantAuthPorts } from '../grant-auth'

/** A fixture's keys: `control` signs grants and `host` proves the ready frame. */
interface FixtureKeys {
  control: { publicKey: KeyObject }
  host: { privateKey: KeyObject }
}

/** The real grant checks over a fixture's authority and keys; the keyset knows only `claims.kid`. */
export function fixtureGrantAuth(
  authority: Authority,
  claims: Pick<GrantPayload, 'iss' | 'kid'>,
  keys: FixtureKeys,
  hello: HostHello,
  overrides: Partial<GrantAuthPorts> = {},
) {
  return createGrantAuth({
    authority,
    origin: claims.iss,
    hello,
    key: keys.host.privateKey,
    keyset: { get: async (kid) => (kid === claims.kid ? keys.control.publicKey : undefined) },
    ...overrides,
  })
}
