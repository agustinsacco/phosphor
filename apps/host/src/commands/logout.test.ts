import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTROL_ROUTES } from '@phosphor/shared/control-api'
import { controlMachine, oldIdentity, type ControlMachine } from '../control/__fixtures__/machine'
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
})
