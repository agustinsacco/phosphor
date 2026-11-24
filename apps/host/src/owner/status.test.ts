import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ControlLink, ControlLinkState } from '../control/link'
import { localStatus, type LocalStatusPorts } from './status'
import { localSocketPaths } from './socket'

const machineId = randomUUID()
function ports(state: ControlLinkState | null, standby = false): LocalStatusPorts {
  const link =
    state &&
    ({
      state: () => state,
      mode: () => state.kind,
    } as unknown as ControlLink)
  return {
    machineId,
    hostVersion: '1.2.3',
    daemon: { standby: () => standby, link: () => link },
    features: () => ['owner-socket'],
    ownerLock: async () => (standby ? null : { owner: 'daemon', pid: 42 }),
  }
}

describe('machine.local', () => {
  it('gives a local caller the machine id, version and mode only', async () => {
    const enrolled: ControlLinkState = {
      kind: 'enrolled',
      hostId: randomUUID(),
      label: 'Mac',
      ownerLogin: 'a',
    }
    expect(await localStatus(ports(enrolled), { kind: 'local', clientId: randomUUID() })).toEqual({
      machineId,
      hostVersion: '1.2.3',
      mode: 'enrolled',
    })
  })

  it('gives the owner enrollment, the owner lock and the features', async () => {
    const hostId = randomUUID()
    const owner = { kind: 'owner', clientId: randomUUID() } as const
    expect(
      await localStatus(ports({ kind: 'enrolled', hostId, label: 'Mac', ownerLogin: null }), owner),
    ).toEqual({
      machineId,
      hostVersion: '1.2.3',
      mode: 'enrolled',
      features: ['owner-socket'],
      enrolled: { hostId, label: 'Mac', ownerLogin: null },
      ownerLock: { held: true, holder: 'daemon', pid: 42, standby: false },
    })
    const offer = { userCode: 'BCDFGHJK', fingerprint: 'f', expiresAt: '2026-01-01T00:00:00.000Z' }
    expect(await localStatus(ports({ kind: 'enrolling', offer }), owner)).toMatchObject({
      mode: 'enrolling',
      enrolled: null,
      enrolling: offer,
    })
  })

  it('reads local mode and standby before a control link exists', async () => {
    expect(
      await localStatus(ports(null, true), { kind: 'owner', clientId: randomUUID() }),
    ).toMatchObject({
      mode: 'local',
      enrolled: null,
      ownerLock: { held: false, holder: null, pid: null, standby: true },
    })
  })
})

describe('the socket path candidates', () => {
  // Pure: no folder is created and nothing binds.
  it('prefers the runtime folder on Linux, then <state>/run, then a hashed /tmp name', () => {
    const context = {
      env: { XDG_STATE_HOME: '/s', XDG_RUNTIME_DIR: '/run/user/501' },
      home: '/h',
      uid: 501,
    }
    const linux = localSocketPaths(context, 'linux')
    expect(linux.slice(0, 2)).toEqual([
      '/run/user/501/phosphor-host/phosphor.sock',
      '/s/phosphor-host/run/phosphor.sock',
    ])
    expect(linux[2]).toMatch(/^\/tmp\/phosphor-501\/[0-9a-f]{16}\.sock$/)
    const mac = localSocketPaths(context, 'darwin')
    expect(mac[0]).toBe('/s/phosphor-host/run/phosphor.sock')
    expect(mac[1]).toBe(linux[2])
    const other = localSocketPaths({ ...context, env: { XDG_STATE_HOME: '/t' } }, 'darwin')
    expect(other[1]).not.toBe(mac[1])
  })
})
