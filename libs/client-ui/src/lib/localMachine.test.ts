import { afterEach, expect, it, vi } from 'vitest'
import { localMachineLabel } from './localMachine'

afterEach(() => vi.unstubAllGlobals())

it('names the local machine in its platform’s own word', () => {
  expect(localMachineLabel('darwin')).toBe('This Mac')
  expect(localMachineLabel('linux')).toBe('This computer')
})

it('reads the client platform when none is given, and says "This computer" without a bridge', () => {
  expect(localMachineLabel()).toBe('This computer')
  vi.stubGlobal('window', { phosphor: { platform: 'darwin' } })
  expect(localMachineLabel()).toBe('This Mac')
  // A browser on Windows reports win32; it has no Desktop build, so no word of its own.
  vi.stubGlobal('window', { phosphor: { platform: 'win32' } })
  expect(localMachineLabel()).toBe('This computer')
})
