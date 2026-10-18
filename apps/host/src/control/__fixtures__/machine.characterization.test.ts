import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTROL_ROUTES, HOST_HEADERS, formatKeyFingerprint } from '@phosphor/shared/control-api'
import {
  controlMachine,
  hostId,
  oldId,
  oldIdentity,
  serverView,
  timestamp,
  type ControlMachine,
} from './machine'

const machines: ControlMachine[] = []
afterEach(async () => {
  for (const machine of machines.splice(0)) await machine.cleanup()
})
async function machineFor() {
  const machine = await controlMachine()
  machines.push(machine)
  return machine
}
const url = (path: string) => `https://example.com${path}`
const start = Date.parse(timestamp)
function ports(machine: ControlMachine) {
  const { fetch, now, wait } = machine.context
  if (!fetch || !now || !wait) throw new Error('controlMachine has no transport')
  return { fetch, now, wait }
}

describe('controlMachine exports', () => {
  it('exports the enrolled and earlier identities', () => {
    expect(hostId).toBe('0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00')
    expect(oldId).toBe('0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d01')
    expect(timestamp).toBe('2026-10-10T00:00:00.000Z')
    expect(serverView).toEqual({
      hostId,
      label: 'bee1',
      owner: { login: 'me' },
      enrolledAt: timestamp,
      lastSeenAt: null,
    })
    expect(oldIdentity).toEqual({
      version: 1,
      hostId: oldId,
      label: 'earlier',
      ownerLogin: 'me',
      controlUrl: 'https://example.com',
      savedAt: timestamp,
    })
  })
})

describe('controlMachine context', () => {
  it('writes an owner-only config and a linux bee1 context on the fixture clock', async () => {
    const machine = await machineFor()
    expect(machine.root.startsWith(join(tmpdir(), 'host-control-'))).toBe(true)
    expect(machine.configPath).toBe(join(machine.root, 'conf', 'config.json'))
    expect(machine.config).toEqual({
      version: 1,
      pi: { executable: '/usr/bin/pi' },
      repositories: ['/srv/a'],
      control: { url: 'https://example.com' },
    })
    expect(JSON.parse(readFileSync(machine.configPath, 'utf8'))).toEqual(machine.config)
    expect(statSync(machine.configPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(machine.root, 'conf')).mode & 0o777).toBe(0o700)
    expect(machine.context).toMatchObject({
      configPath: machine.configPath,
      uid: process.getuid?.(),
      hostname: 'bee1',
      platform: 'linux',
      arch: 'x64',
    })
    expect(machine.context.store).toBe(machine.store)
    expect(machine.context.signal).toBe(machine.abort.signal)
    expect(ports(machine).now()).toBe(start)
    expect([machine.calls, machine.output, machine.waits, machine.polls()]).toEqual([[], [], [], 0])
  })

  it('records printed lines', async () => {
    const machine = await machineFor()
    machine.context.print('one')
    machine.context.print('two')
    expect(machine.output).toEqual(['one', 'two'])
  })

  it('advances the clock on each wait and runs the wait hook after it', async () => {
    const machine = await machineFor()
    const seen: number[] = []
    await ports(machine).wait(5000)
    machine.onWait(async () => {
      await Promise.resolve()
      seen.push(ports(machine).now())
    })
    await ports(machine).wait(250)
    expect(machine.waits).toEqual([5000, 250])
    expect(seen).toEqual([start + 5250])
    expect(ports(machine).now()).toBe(start + 5250)
    machine.onWait(undefined)
    await ports(machine).wait(1)
    expect(seen).toEqual([start + 5250])
  })

  it('keeps each machine state separate', async () => {
    const first = await machineFor()
    const second = await machineFor()
    await ports(first).wait(1000)
    first.setMode('offline')
    expect(ports(second).now()).toBe(start)
    expect((await ports(second).fetch(url(CONTROL_ROUTES.hostRevoke))).status).toBe(204)
    expect(first.root).not.toBe(second.root)
  })
})

describe('controlMachine transport', () => {
  it('creates an enrollment for the sent key, expiring ten minutes from now', async () => {
    const machine = await machineFor()
    const key = Buffer.from('a public key')
    await ports(machine).wait(1000)
    const response = await ports(machine).fetch(url(CONTROL_ROUTES.enrollments), {
      method: 'POST',
      headers: { [HOST_HEADERS.key]: key.toString('base64url') },
      body: '{"a":1}',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      enrollmentId: hostId,
      userCode: 'BCDFGHJK',
      keyFingerprint: formatKeyFingerprint(createHash('sha256').update(key).digest()),
      expiresAt: new Date(start + 1000 + 600_000).toISOString(),
      pollIntervalSec: 5,
    })
    machine.setCreation({ userCode: 'ZZZZZZZZ', extra: true })
    expect(
      await (await ports(machine).fetch(url(CONTROL_ROUTES.enrollments), {})).json(),
    ).toMatchObject({ enrollmentId: hostId, userCode: 'ZZZZZZZZ', extra: true })
  })

  it('records path, method, body, headers and clock for every call', async () => {
    const machine = await machineFor()
    await ports(machine).fetch(url(`${CONTROL_ROUTES.hostSelf}?ignored=1`), {
      method: 'GET',
      headers: { [HOST_HEADERS.host]: hostId },
    })
    await ports(machine).wait(30)
    await ports(machine).fetch(new URL(url(CONTROL_ROUTES.hostRevoke)), {
      method: 'POST',
      body: 'text',
    })
    await ports(machine).fetch(url(CONTROL_ROUTES.enrollmentPoll), {
      body: new Uint8Array([1]),
    })
    expect(machine.calls.map(({ path, method, body, at }) => ({ path, method, body, at }))).toEqual(
      [
        { path: CONTROL_ROUTES.hostSelf, method: 'GET', body: '', at: start },
        { path: CONTROL_ROUTES.hostRevoke, method: 'POST', body: 'text', at: start + 30 },
        { path: CONTROL_ROUTES.enrollmentPoll, method: '', body: '', at: start + 30 },
      ],
    )
    expect(machine.calls[0]?.headers).toBeInstanceOf(Headers)
    expect(machine.calls[0]?.headers.get(HOST_HEADERS.host)).toBe(hostId)
  })

  it('counts polls and answers the current poll answer', async () => {
    const machine = await machineFor()
    const poll = async () =>
      (await ports(machine).fetch(url(CONTROL_ROUTES.enrollmentPoll), { method: 'POST' })).json()
    expect(await poll()).toEqual({
      status: 'approved',
      hostId,
      label: 'bee1',
      owner: { login: 'me' },
    })
    machine.setAnswer({ status: 'pending' })
    expect(await poll()).toEqual({ status: 'pending' })
    expect(machine.polls()).toBe(2)
  })

  it('revokes with 204 and answers any other route with the server view for the sent host', async () => {
    const machine = await machineFor()
    const revoke = await ports(machine).fetch(url(CONTROL_ROUTES.hostRevoke))
    expect([revoke.status, await revoke.text()]).toEqual([204, ''])
    const self = await ports(machine).fetch(url(CONTROL_ROUTES.hostSelf), {
      headers: { [HOST_HEADERS.host]: oldId },
    })
    expect(await self.json()).toEqual({ ...serverView, hostId: oldId })
    const anonymous = await ports(machine).fetch(url(CONTROL_ROUTES.machines))
    expect(await anonymous.json()).toEqual({ ...serverView, hostId: null })
  })

  it('fails by mode: offline throws, gone refuses host routes, unavailable is 503', async () => {
    const machine = await machineFor()
    machine.setMode('offline')
    await expect(ports(machine).fetch(url(CONTROL_ROUTES.enrollments))).rejects.toThrow(
      'transport contains secret',
    )
    machine.setMode('gone')
    const gone = await ports(machine).fetch(url(CONTROL_ROUTES.hostHeartbeat))
    expect([gone.status, await gone.text()]).toEqual([410, 'secret'])
    expect((await ports(machine).fetch(url(CONTROL_ROUTES.enrollmentPoll))).status).toBe(200)
    machine.setMode('unavailable')
    const unavailable = await ports(machine).fetch(url(CONTROL_ROUTES.hostRevoke))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({
      error: { code: 'unavailable', message: 'secret' },
    })
    expect(machine.calls).toHaveLength(4)
    expect(machine.polls()).toBe(1)
  })

  it('applies the final mode only to requests from the enrolled host', async () => {
    const machine = await machineFor()
    machine.setFinalMode('gone')
    const enrolled = { headers: { [HOST_HEADERS.host]: hostId } }
    expect((await ports(machine).fetch(url(CONTROL_ROUTES.hostSelf), enrolled)).status).toBe(410)
    const earlier = { headers: { [HOST_HEADERS.host]: oldId } }
    expect((await ports(machine).fetch(url(CONTROL_ROUTES.hostSelf), earlier)).status).toBe(200)
    machine.setMode('offline')
    machine.setFinalMode('ok')
    expect((await ports(machine).fetch(url(CONTROL_ROUTES.hostSelf), enrolled)).status).toBe(200)
    await expect(ports(machine).fetch(url(CONTROL_ROUTES.hostSelf), earlier)).rejects.toThrow()
  })
})

describe('controlMachine enrollment identity and cleanup', () => {
  it('enrolls the earlier identity in the store', async () => {
    const machine = await machineFor()
    expect(await machine.store.load()).toBeNull()
    await machine.enrollOld()
    expect((await machine.store.load())?.identity).toEqual(oldIdentity)
  })

  it('removes the machine root on cleanup', async () => {
    const machine = await controlMachine()
    await machine.cleanup()
    expect(existsSync(machine.root)).toBe(false)
    await machine.cleanup()
  })
})
