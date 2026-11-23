import { expect, it, vi } from 'vitest'
import { serviceLanesRunning, serviceQuitOptions } from './quit'
const state = vi.hoisted(() => ({ mode: 'in-app', activity: 'working' }))
vi.mock('../local-machine/mode', () => ({ localRuntimeMode: () => state.mode }))
vi.mock('../local-machine/same-machine', () => ({
  sameMachine: () => ({ lanes: [{ activity: state.activity }] }),
}))
it('preserves in-app quit and restart; daemon lanes survive either option', () => {
  expect(serviceLanesRunning()).toBe(false)
  expect(serviceQuitOptions('quit')).toEqual({})
  state.mode = 'daemon'
  expect(serviceLanesRunning()).toBe(true)
  expect(serviceQuitOptions('quit')).toMatchObject({
    buttons: ['Keep working', 'Quit Desktop'],
    detail: expect.stringContaining('keep running after Desktop quits'),
  })
  expect(serviceQuitOptions('update').buttons).toEqual(['Keep working', 'Restart Desktop'])
  state.activity = 'stopped'
  expect(serviceLanesRunning()).toBe(false)
})
