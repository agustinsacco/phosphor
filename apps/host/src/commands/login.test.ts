import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES } from '@phosphor/shared/control-api'
import {
  controlMachine,
  hostId,
  oldIdentity,
  type ControlMachine,
} from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import { publicIdentity } from '../control/signer'
import { runLogin } from './login'

let machine: ControlMachine
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  machine = await controlMachine()
})
afterEach(async () => {
  try {
    expect(console.log).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    await machine.cleanup()
  }
})

describe('phosphor login', () => {
  it('prints the code and actual key fingerprint, respects the interval and commits only after approval', async () => {
    let waits = 0
    machine.onWait(async () => {
      expect(await machine.store.load()).toBeNull()
      if (++waits === 1) machine.setAnswer({ status: 'pending' })
      else machine.setAnswer({ status: 'approved', hostId, label: 'bee1', owner: { login: 'me' } })
    })
    expect(await runLogin(machine.context)).toEqual({
      exitCode: 0,
      message: 'This machine is now "bee1" on @me\'s account.',
    })
    expect(machine.waits).toEqual([5000, 5000])
    const loaded = await machine.store.load()
    expect(loaded?.identity).toEqual({
      version: 1,
      controlUrl: 'https://example.com',
      hostId,
      label: 'bee1',
      ownerLogin: 'me',
      savedAt: '2026-10-10T00:00:10.000Z',
    })
    expect(machine.output.join('\n')).toContain('BCDF-GHJK')
    expect(machine.output.join('\n')).toContain(loaded && publicIdentity(loaded.key).keyFingerprint)
    expect(machine.calls.map((call) => call.path)).toEqual([
      CONTROL_ROUTES.enrollments,
      CONTROL_ROUTES.enrollmentPoll,
      CONTROL_ROUTES.enrollmentPoll,
      CONTROL_ROUTES.hostSelf,
    ])
    const pem = await readFile(
      join(identityDirectory(machine.configPath), `host-key.${hostId}.pem`),
      'utf8',
    )
    const output = [...machine.output, (await runLogin(machine.context)).message].join('\n')
    expect(output).not.toContain(pem)
    expect(output).not.toContain('PRIVATE KEY')
    for (const call of machine.calls) {
      expect(output).not.toContain(call.headers.get('x-phosphor-signature'))
      expect(output).not.toContain('x-phosphor-')
    }
  })
  it('returns without writes when already enrolled and confirmed', async () => {
    await machine.enrollOld()
    const before = await machine.store.load()
    expect((await runLogin(machine.context)).exitCode).toBe(0)
    expect(machine.calls.map((call) => call.method)).toEqual(['GET'])
    expect((await machine.store.load())?.identity).toEqual(before?.identity)
  })
  it.each(['cancelled', 'expired', 'deadline'])(
    'leaves the old identity and key untouched when %s',
    async (outcome) => {
      await machine.enrollOld()
      machine.setMode('gone')
      const old = await machine.store.load()
      if (outcome === 'cancelled')
        machine.onWait(() => {
          machine.abort.abort()
        })
      if (outcome === 'expired') machine.setAnswer({ status: 'expired' })
      if (outcome === 'deadline') {
        machine.setAnswer({ status: 'pending' })
        machine.setCreation({ expiresAt: '2026-10-10T00:00:05.000Z' })
      }
      const result = await runLogin(machine.context)
      expect(result.exitCode).toBe(outcome === 'cancelled' ? 130 : 75)
      if (outcome !== 'cancelled')
        expect(result.message).toBe('The code expired. Run phosphor login again.')
      const retained = await machine.store.load()
      expect(retained?.identity).toEqual(oldIdentity)
      expect(retained && publicIdentity(retained.key)).toEqual(old && publicIdentity(old.key))
    },
  )
  it('starts fresh after gone and replaces only once approved', async () => {
    await machine.enrollOld()
    machine.setMode('gone')
    machine.onWait(async () => {
      expect((await machine.store.load())?.identity).toEqual(oldIdentity)
    })
    expect((await runLogin(machine.context)).exitCode).toBe(0)
    expect(machine.output[0]).toContain('removed from the account')
    expect((await machine.store.load())?.identity.hostId).toBe(hostId)
  })
  it.each(['offline', 'unavailable'] as const)(
    'keeps an approved identity if confirmation is %s',
    async (mode) => {
      machine.setFinalMode(mode)
      const result = await runLogin(machine.context)
      expect(result.exitCode).toBe(0)
      expect(result.message).toContain(
        'Saved. Phosphor could not confirm it yet; phosphor status will check again.',
      )
      expect((await machine.store.load())?.identity.hostId).toBe(hostId)
    },
  )
  it('deletes a newly saved identity and exits 77 when final confirmation says gone', async () => {
    machine.setFinalMode('gone')
    expect((await runLogin(machine.context)).exitCode).toBe(77)
    expect(await machine.store.load()).toBeNull()
  })
  it.each(['offline', 'unavailable'] as const)(
    'fails without a new enrollment when the earlier self check is %s',
    async (mode) => {
      await machine.enrollOld()
      machine.setMode(mode)
      expect((await runLogin(machine.context)).exitCode).toBe(75)
      expect(machine.calls.map((call) => call.path)).toEqual([CONTROL_ROUTES.hostSelf])
    },
  )
  it('does not save malformed approvals or mismatched fingerprints', async () => {
    machine.setAnswer({ status: 'approved', hostId: 'bad', label: 'bee1', owner: { login: 'me' } })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(await machine.store.load()).toBeNull()
    machine.setCreation({ keyFingerprint: '0000-0000-0000-0000' })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(await machine.store.load()).toBeNull()
  })
  it('recovers an incomplete key, but refuses an origin mismatch before either origin is contacted', async () => {
    await machine.enrollOld()
    await writeFile(
      join(identityDirectory(machine.configPath), `host-key.${oldIdentity.hostId}.pem`),
      'invalid',
    )
    await writeFile(
      machine.configPath,
      JSON.stringify({ ...machine.config, control: { url: 'https://other.example' } }),
    )
    const result = await runLogin(machine.context)
    expect(result.exitCode).toBe(78)
    expect(result.message).toContain('Run phosphor logout --local, then phosphor login.')
    expect(machine.calls).toEqual([])
    await writeFile(machine.configPath, JSON.stringify(machine.config))
    expect((await runLogin(machine.context)).exitCode).toBe(0)
  })
  it('bounds pending enrollment even when the server clock or expiry is far ahead', async () => {
    machine.setAnswer({ status: 'pending' })
    machine.setCreation({ expiresAt: '2099-10-10T00:00:00.000Z', pollIntervalSec: 60 })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(machine.waits.reduce((total, ms) => total + ms, 0)).toBe(600_000)
    expect(machine.polls()).toBe(9)
    expect(await machine.store.load()).toBeNull()
  })
})
