// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockPhosphor } from './mockPhosphor'

// The browser harness (`npm run dev:web`) keeps the Machines preview switch in
// localStorage. Only its own channel may write it.
beforeEach(() => {
  localStorage.clear()
  installMockPhosphor()
})

afterEach(() => vi.useRealTimers())

const preview = async (): Promise<boolean | undefined> =>
  (await window.phosphor.invoke('app:getPrefs')).machinesPreview

it('keeps the Machines preview switch apart from other preference writes', async () => {
  await window.phosphor.invoke('app:setFontPrefs', { chatFontSize: 15 } as never)
  await window.phosphor.invoke('app:setRecentWorkspaces', [])
  await window.phosphor.invoke('pi:patchAgentSettings', 'global', undefined, {
    hideThinkingBlock: true,
  })
  expect(localStorage.getItem('mock:machinesPreview')).toBeNull()
  expect(await preview()).toBe(false)

  await window.phosphor.invoke('app:setMachinesPreview', true)
  expect(await preview()).toBe(true)
  await window.phosphor.invoke('app:setMachinesPreview', false)
  expect(await preview()).toBe(false)
})

it('keeps control signed-out by default and supplies signed-in empty machine data', async () => {
  await window.phosphor.invoke('account:signOut')
  for (const result of [
    await window.phosphor.invoke('control:machines'),
    await window.phosphor.invoke('control:lookupEnrollment', 'BCDF-GHJK'),
    await window.phosphor.invoke('control:approveEnrollment', 'BCDF-GHJK', 'bee1'),
    await window.phosphor.invoke('control:removeMachine', '11111111-1111-4111-8111-111111111111'),
  ])
    expect(result).toMatchObject({ ok: false, error: { code: 'signed-out' } })
  vi.useFakeTimers()
  await window.phosphor.invoke('account:setPreview', true)
  await window.phosphor.invoke('account:signIn')
  await vi.advanceTimersByTimeAsync(1500)
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({ ok: true, machines: [] })
  expect(await window.phosphor.invoke('control:lookupEnrollment', 'BCDF-GHJK')).toMatchObject({
    error: { code: 'not-found' },
  })
  await window.phosphor.invoke('account:setPreview', false)
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({
    error: { code: 'signed-out' },
  })
})
