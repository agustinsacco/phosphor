import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  controlMachine,
  oldId,
  oldIdentity,
  serverView,
  type ControlMachine,
} from '../control/__fixtures__/machine'
import { renderStatus, runStatus } from './status'

let machine: ControlMachine
beforeEach(async () => {
  machine = await controlMachine()
})
afterEach(async () => {
  await machine.cleanup()
})
describe('phosphor status', () => {
  it('reports not enrolled without network traffic', async () => {
    const result = await runStatus(machine.context)
    expect(result).toEqual({
      exitCode: 69,
      report: { version: 1, status: 'not-enrolled', identity: null, server: null, error: null },
    })
    expect(renderStatus(result.report)).toBe(
      'This machine is not signed in.\nNext: phosphor setup\n',
    )
    expect(machine.calls).toEqual([])
  })
  it('reports local identity plus the server view, with no key material', async () => {
    await machine.enrollOld()
    const result = await runStatus(machine.context)
    expect(result).toEqual({
      exitCode: 0,
      report: {
        version: 1,
        status: 'confirmed',
        identity: oldIdentity,
        server: { ...serverView, hostId: oldId },
        error: null,
      },
    })
    expect(renderStatus(result.report)).toContain(
      'Enrolled: 2026-10-10T00:00:00.000Z. Last seen: never.',
    )
    expect(renderStatus(result.report)).not.toContain('Next:')
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY|signature|headers|publicKey/)
  })
  it.each([
    ['gone', 77, 'removed'],
    ['offline', 75, 'unreachable'],
    ['unavailable', 75, 'unreachable'],
  ] as const)('maps %s to exit %i and %s', async (mode, code, status) => {
    await machine.enrollOld()
    machine.setMode(mode)
    const result = await runStatus(machine.context)
    expect(result.exitCode).toBe(code)
    expect(result.report.status).toBe(status)
    expect(result.report.identity).toEqual(oldIdentity)
    expect(renderStatus(result.report)).not.toContain('secret')
    expect(renderStatus(result.report)).toContain('Next: phosphor setup')
  })
  it('refuses an origin mismatch without contacting either server', async () => {
    await machine.enrollOld()
    await writeFile(
      machine.configPath,
      JSON.stringify({ ...machine.config, control: { url: 'https://other.example' } }),
    )
    const result = await runStatus(machine.context)
    expect(result.exitCode).toBe(78)
    expect(result.report.error).toContain(
      'signed in to https://example.com, but the config points at https://other.example',
    )
    expect(machine.calls).toEqual([])
  })
})
