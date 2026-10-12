// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { installMockPhosphor } from './mockPhosphor'

// The browser harness (`npm run dev:web`) keeps the Machines preview switch in
// localStorage. Only its own channel may write it.
beforeEach(() => {
  localStorage.clear()
  installMockPhosphor()
})

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
