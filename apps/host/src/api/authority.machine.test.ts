import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAuthority } from './authority'

function opened() {
  const authority = createAuthority(() => 0)
  authority.accept({ accepted: true, nextInSec: 30, ownerId: randomUUID(), epoch: 1 })
  return authority
}

describe('the machine-origin opt-in', () => {
  it('is off by default: no machineOrigin in the snapshot and no machineGrants to report', () => {
    const authority = opened()
    expect(authority.snapshot()).not.toHaveProperty('machineOrigin')
    expect(authority.machineGrants()).toBe(false)
    authority.accept({ accepted: true, nextInSec: 30, machineReach: true })
    expect(authority.snapshot()).not.toHaveProperty('machineOrigin')
  })

  it('opens with the local opt-in unless the last beat that said so turned reach off', () => {
    const authority = opened()
    authority.setMachineOps(true)
    expect(authority.snapshot()).toMatchObject({ machineOrigin: true })
    expect(authority.machineGrants()).toBe(true)
    authority.accept({ accepted: true, nextInSec: 30, machineReach: false })
    expect(authority.snapshot()).not.toHaveProperty('machineOrigin')
    // A beat that leaves the switch out is no news; the Host still reports its own side.
    authority.accept({ accepted: true, nextInSec: 30 })
    expect(authority.snapshot()).not.toHaveProperty('machineOrigin')
    expect(authority.machineGrants()).toBe(true)
    authority.accept({ accepted: true, nextInSec: 30, machineReach: true })
    expect(authority.snapshot()).toMatchObject({ machineOrigin: true })
  })

  it('tells listeners when the opt-in changes, and only then', () => {
    const authority = opened()
    const listener = vi.fn()
    authority.onChange(listener)
    authority.setMachineOps(true)
    authority.setMachineOps(true)
    expect(listener).toHaveBeenCalledOnce()
    authority.setMachineOps(false)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(authority.snapshot()).not.toHaveProperty('machineOrigin')
  })

  it('stays closed while the authority is closed, whatever the opt-in', () => {
    const authority = createAuthority(() => 0)
    authority.setMachineOps(true)
    expect(authority.snapshot()).toBeNull()
  })
})
