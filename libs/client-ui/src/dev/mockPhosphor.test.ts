// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockPhosphor } from './mockPhosphor'
beforeEach(() => {
  localStorage.clear()
  installMockPhosphor()
})
afterEach(() => vi.useRealTimers())
it('characterizes local routine routing, Host refusal and Brain dispatch', async () => {
  const snapshot = await window.phosphor.invoke('routines:list')
  expect(snapshot).toMatchObject({ routines: [], runs: [], background: false, error: null })
  await expect(window.phosphor.invoke('routines:list', 'host:remote')).rejects.toThrow(
    'Machine routines are unavailable in the browser harness.',
  )
  expect(await window.phosphor.invoke('routines:list')).toEqual(snapshot)
  expect(await window.phosphor.invoke('brain:status')).toMatchObject({ supported: true })
})
it('keeps control signed out by default and supports first-class enrollment', async () => {
  await window.phosphor.invoke('account:signOut')
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({
    error: { code: 'signed-out' },
  })
  vi.useFakeTimers()
  await window.phosphor.invoke('account:signIn')
  await vi.advanceTimersByTimeAsync(1500)
  expect(await window.phosphor.invoke('control:lookupEnrollment', 'BCDFGHJK')).toMatchObject({
    ok: true,
    hostname: 'buildbox',
  })
  expect(
    await window.phosphor.invoke('control:approveEnrollment', 'BCDFGHJK', 'buildbox'),
  ).toMatchObject({ ok: true })
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({ ok: true })
  await window.phosphor.invoke('account:signOut')
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({
    error: { code: 'signed-out' },
  })
})
it("answers app:about, so This Mac's Details and Settings → Advanced show a version", async () => {
  expect(await window.phosphor.invoke('app:about')).toMatchObject({
    appVersion: '0.0.0-dev',
    platform: window.phosphor.platform,
  })
})
