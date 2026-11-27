// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LocalMachineStatus } from '@phosphor/shared/ipc'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { PlatformProvider, WIDE_BROWSER_PLATFORM, DESKTOP_PLATFORM } from '@/platform/Platform'
import { LocalServiceSection } from './LocalServiceSection'

const ready: LocalMachineStatus = {
  mode: 'daemon',
  migration: 'committed',
  service: 'ready',
  serviceVersion: '1.2.3',
}
let current: LocalMachineStatus
const read = vi.fn(() => current)
const action = vi.fn(async () => ({ ok: true, message: 'Started: service.update' }))
const makeFake = () =>
  createFakePhosphor({ 'app:localMachine': read, 'app:localMachineAction': action })
let fake: ReturnType<typeof makeFake>,
  restore: () => void,
  root: ReturnType<typeof createRoot>,
  el: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  current = ready
  fake = makeFake()
  restore = installFakePhosphor(fake)
  el = document.createElement('div')
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
async function show(browser = false) {
  await act(async () =>
    root.render(
      <PlatformProvider value={browser ? WIDE_BROWSER_PLATFORM : DESKTOP_PLATFORM}>
        <LocalServiceSection machine="local" />
      </PlatformProvider>,
    ),
  )
}
function push(next: LocalMachineStatus) {
  current = next
  act(() => fake.events.onLocalMachineChanged.emit(next))
}
async function click(label: string) {
  const b = [...el.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(b, label).toBeDefined()
  await act(async () => b!.click())
}
it('never reads or shows the local service card on the PWA', async () => {
  await show(true)
  expect(read).not.toHaveBeenCalled()
  expect(el.textContent).toBe('')
})
it('shows the consent notice and explicit action and limits restart to a committed in-app migration', async () => {
  current = { mode: 'in-app', migration: 'consent-needed' }
  await show()
  expect(el.textContent).toContain(
    'Another Phosphor service already runs lanes on this Mac. Stop or uninstall it, then restart Phosphor.',
  )
  await click('Continue setup')
  expect(action).toHaveBeenCalledWith('consent-migration')
  push({ mode: 'in-app', migration: 'committed' })
  expect(el.textContent).toContain('Restart to finish setting up this Mac')
  push(ready)
  expect(el.textContent).not.toContain('Restart to finish')
})

it('says in-app why the Phosphor service is not set up yet, and what happens next', async () => {
  const inApp: LocalMachineStatus = { mode: 'in-app', migration: 'not-needed' }
  current = {
    ...inApp,
    install: { state: 'failed', detail: 'pi: pi --version failed: env: node: No such file' },
  }
  await show()
  expect(el.textContent).toContain('This Mac runs its lanes in Desktop.')
  expect(el.textContent).toContain('Couldn’t set up the Phosphor service')
  expect(el.textContent).toContain('pi: pi --version failed: env: node: No such file')
  push({ ...inApp, install: { state: 'installing', step: 'download', version: '0.2.93' } })
  expect(el.textContent).toContain('Downloading the Phosphor service 0.2.93')
  push({ ...inApp, install: { state: 'installed', version: '0.2.93' } })
  expect(el.textContent).toContain(
    'Phosphor service 0.2.93 is installed. This Mac moves its lanes to it the next time Phosphor starts.',
  )
})

it('explains protected storage and offers an explicit key access retry after failure', async () => {
  current = { ...ready, service: 'down', ownerKeyAccess: 'checking' }
  await show()
  expect(el.textContent).toContain('respond in its own dialog')
  expect(el.textContent).not.toContain('Retry key access')
  push({ ...current, ownerKeyAccess: 'unavailable' })
  expect(el.textContent).toContain('Keychain or keyring')
  expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(false)
  await click('Retry key access')
  expect(action).toHaveBeenCalledWith('retry-owner-key')
  push(ready)
  expect(el.textContent).not.toContain('Retry key access')
})

it('offers Start service for a genuine outage, not a shutdown during an update', async () => {
  current = { ...ready, service: 'down' }
  await show()
  expect(el.textContent).toContain('Start service')
  push(ready)
  expect(el.textContent).not.toContain('Start service')
})
