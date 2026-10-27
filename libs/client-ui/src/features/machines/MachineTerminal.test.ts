import { describe, expect, it } from 'vitest'
import { machineShellRefusal } from './MachineTerminal'

const ready = {
  state: 'ready',
  capabilities: ['terminal', 'sessions.control'],
  machineShell: true,
}

describe('machineShellRefusal', () => {
  it('allows a connected Host that supports machine shells', () => {
    expect(machineShellRefusal(ready, 'bee')).toBeNull()
  })
  it('names the one thing in the way', () => {
    expect(machineShellRefusal(undefined, 'bee')).toBe('Connect to bee to open a terminal.')
    expect(machineShellRefusal({ ...ready, state: 'connecting' }, 'bee')).toContain('Connect')
    expect(machineShellRefusal({ ...ready, capabilities: ['terminal'] }, 'bee')).toBe(
      'This device may not open terminals on bee.',
    )
    expect(machineShellRefusal({ ...ready, machineShell: undefined }, 'bee')).toBe(
      'Update the Host on bee to open a terminal here.',
    )
  })
})
