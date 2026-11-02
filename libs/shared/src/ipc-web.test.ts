import { expect, it } from 'vitest'
import { IPC_SCOPE } from './ipc-scope'
import { IPC_WEB } from './ipc-web'
it('classifies every invoke channel and gives every refusal a reason', () => {
  expect(Object.keys(IPC_WEB).sort()).toEqual(Object.keys(IPC_SCOPE).sort())
  for (const entry of Object.values(IPC_WEB)) {
    expect(['remote-supported', 'browser-local', 'unsupported']).toContain(entry.kind)
    if (entry.kind === 'unsupported') expect(entry.reason.length).toBeGreaterThan(15)
  }
})
it('keeps lane and branch prefs in the browser, which apply to every Host from this device', () => {
  for (const channel of ['app:setLanePrefs', 'app:setWorktreePrefs'] as const)
    expect(IPC_WEB[channel]).toEqual({ kind: 'browser-local' })
})
