import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTROL_ROUTES } from '@phosphor/shared/control-api'
import {
  controlMachine,
  hostId,
  oldIdentity,
  type ControlMachine,
} from '../control/__fixtures__/machine'
import { freshKey, publicIdentity } from '../control/signer'
import { runLogout } from './logout'

let machine: ControlMachine
beforeEach(async () => {
  machine = await controlMachine()
})
afterEach(async () => {
  await machine.cleanup()
})
describe('phosphor logout', () => {
  it('returns success for a machine not enrolled without network I/O', async () => {
    expect(await runLogout(machine.context)).toEqual({
      exitCode: 0,
      message: 'This machine is not signed in.',
    })
    expect(machine.calls).toEqual([])
  })
  it('signs exactly {} for revoke then deletes locally', async () => {
    await machine.enrollOld()
    expect(await runLogout(machine.context)).toEqual({
      exitCode: 0,
      message: 'This machine is signed out.',
    })
    expect(machine.calls.map(({ path, body, method }) => ({ path, body, method }))).toEqual([
      { path: CONTROL_ROUTES.hostRevoke, body: '{}', method: 'POST' },
    ])
    expect(await machine.store.load()).toBeNull()
  })
  it('deletes locally and exits 0 when already removed', async () => {
    await machine.enrollOld()
    machine.setMode('gone')
    expect(await runLogout(machine.context)).toEqual({
      exitCode: 0,
      message: 'This machine was already removed from the account.',
    })
    expect(await machine.store.load()).toBeNull()
  })
  it.each(['offline', 'unavailable'] as const)(
    'keeps identity when %s and gives the --local hint',
    async (mode) => {
      await machine.enrollOld()
      machine.setMode(mode)
      const result = await runLogout(machine.context)
      expect(result.exitCode).toBe(75)
      expect(result.message).toContain('phosphor logout --local')
      expect((await machine.store.load())?.identity).toEqual(oldIdentity)
      expect(result.message).not.toContain('secret')
    },
  )
  it('binds plain logout to the saved origin, but --local works even with invalid config', async () => {
    await machine.enrollOld()
    await writeFile(
      machine.configPath,
      JSON.stringify({ ...machine.config, control: { url: 'https://other.example' } }),
    )
    expect((await runLogout(machine.context)).exitCode).toBe(78)
    expect(machine.calls).toEqual([])
    await writeFile(machine.configPath, '{')
    const result = await runLogout(machine.context, true)
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('stays listed until removed in Phosphor')
    expect(machine.calls).toEqual([])
    expect(await machine.store.load()).toBeNull()
  })
  it('reports a replacement committed during revoke and deletes none of its files', async () => {
    await machine.enrollOld()
    const fetcher = machine.context.fetch
    machine.context.fetch = async (url, init) => {
      if (String(url).endsWith(CONTROL_ROUTES.hostRevoke))
        await machine.store.save({ ...oldIdentity, hostId }, freshKey())
      if (!fetcher) throw new Error('missing fake transport')
      return fetcher(url, init)
    }
    expect(await runLogout(machine.context)).toEqual({
      exitCode: 75,
      message: 'The local identity changed. Nothing was removed locally; run phosphor status.',
    })
    expect((await machine.store.load())?.identity.hostId).toBe(hostId)
  })
  it.each([false, true])('deletes pending files on successful logout, local: %s', async (local) => {
    await machine.enrollOld()
    const key = freshKey()
    await machine.store.savePending(
      {
        version: 1,
        controlUrl: 'https://example.com',
        enrollmentId: hostId,
        userCode: 'BCDFGHJK',
        keyFingerprint: publicIdentity(key).keyFingerprint,
        expiresAt: '2026-10-10T00:10:00.000Z',
        savedAt: oldIdentity.savedAt,
        pollIntervalSec: 5,
      },
      key,
    )
    expect((await runLogout(machine.context, local)).exitCode).toBe(0)
    expect(await machine.store.loadPending()).toBeNull()
  })
})
