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
import { promptChoice } from '@/stores/prompt'
import { LocalServiceSection } from './LocalServiceSection'

vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(async () => 'update') }))
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
async function start() {
  await show()
  await click('Update Phosphor service')
  expect(promptChoice).toHaveBeenCalledOnce()
  expect(action).toHaveBeenCalledWith('update-service')
  expect(el.textContent).toContain('Started')
}
const pausing: LocalMachineStatus = {
  ...ready,
  pause: {
    kind: 'pausing',
    purpose: 'update',
    since: 'now',
    deadline: 'later',
    waitingOn: { turns: 1, routines: 0, subagents: 2 },
  },
}

it('reports an unsuccessful update only after the pause ends on the old version', async () => {
  await start()
  expect(el.textContent).not.toContain("didn't finish")
  push(pausing)
  expect(el.textContent).toContain('Abort now')
  push(ready)
  expect(el.textContent).toContain(
    "The update didn't finish. The Phosphor service is still on 1.2.3.",
  )
  expect(el.textContent).toContain('Update again')
  push({ ...ready, serviceVersion: '2.0.0' })
  expect(el.textContent).not.toContain("didn't finish")
})
it('reports the new version after a successful pause and update', async () => {
  await start()
  push(pausing)
  push({ ...ready, serviceVersion: '2.0.0' })
  expect(el.textContent).toContain('Version 2.0.0')
  expect(el.textContent).not.toContain('Started')
})
it('shows the outage mid-update, then recovers on the new version', async () => {
  await start()
  push(pausing)
  push({ mode: 'daemon', migration: 'committed', service: 'down' })
  expect(el.textContent).toContain('Start service')
  expect(el.textContent).not.toContain('Update again')
  push({ ...ready, serviceVersion: '2.0.0' })
  expect(el.textContent).toContain('Version 2.0.0')
  expect(el.textContent).not.toContain('Started')
})
it('never reads or shows the local service card on the PWA', async () => {
  await show(true)
  expect(read).not.toHaveBeenCalled()
  expect(el.textContent).toBe('')
})
it('shows an unavailable action answer rather than claiming the update started', async () => {
  action.mockResolvedValueOnce({
    ok: false,
    message: "This Mac's Phosphor service isn't ready yet. Try again in a moment.",
  })
  await show()
  await click('Update Phosphor service')
  expect(el.textContent).toContain("isn't ready yet")
  expect(el.textContent).not.toContain('Started')
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
