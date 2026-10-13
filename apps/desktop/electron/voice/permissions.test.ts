import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: {} }))
const { permissionAllowed } = await import('./permissions')

describe('permissionAllowed', () => {
  it('keeps the default for everything but media', () => {
    expect(permissionAllowed('clipboard-sanitized-write', {})).toBe(true)
    expect(permissionAllowed('notifications', { isMainFrame: false })).toBe(true)
  })

  it('gives the app page the microphone', () => {
    expect(permissionAllowed('media', { isMainFrame: true, mediaTypes: ['audio'] })).toBe(true)
  })

  it('refuses the camera, and any capture from a frame', () => {
    expect(permissionAllowed('media', { isMainFrame: true, mediaTypes: ['audio', 'video'] })).toBe(
      false,
    )
    expect(permissionAllowed('media', { isMainFrame: true, mediaTypes: [] })).toBe(false)
    expect(permissionAllowed('media', { isMainFrame: false, mediaTypes: ['audio'] })).toBe(false)
  })
})
