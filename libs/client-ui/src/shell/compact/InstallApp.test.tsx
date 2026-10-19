// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InstallApp } from './InstallApp'
import { installInstructions } from './useInstallApp'
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(two = false): Promise<void> {
  await act(async () =>
    root.render(
      <>
        <InstallApp />
        {two && <InstallApp />}
      </>,
    ),
  )
}
function offer(
  outcome: 'accepted' | 'dismissed' = 'accepted',
  prompt = vi.fn().mockResolvedValue(undefined),
) {
  const event = new Event('beforeinstallprompt', { cancelable: true })
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) })
  return { event, prompt }
}
async function click(text: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent === text,
  )
  expect(button).toBeDefined()
  await act(async () => button?.click())
}
it('offers manual instructions without requesting permissions, prompts or account access', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone Safari')
  await render()
  await click('Install Phosphor')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Add to Home Screen')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Open as Web App')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain(
    'does not add background push',
  )
  expect(document.activeElement?.textContent).toBe('Close')
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(document.activeElement?.textContent).toBe('Install Phosphor')
})
it('shares one deferred Chromium prompt and does not call acceptance a completed install', async () => {
  await render(true)
  const { event, prompt } = offer()
  await act(async () => {
    window.dispatchEvent(event)
  })
  expect(event.defaultPrevented).toBe(true)
  expect(prompt).not.toHaveBeenCalled()
  await click('Install Phosphor')
  expect(prompt).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Finish installation in your browser')
  await click('Install Phosphor')
  expect(prompt).toHaveBeenCalledOnce()
  await click('Close')
  await act(async () => {
    window.dispatchEvent(new Event('appinstalled'))
  })
  expect(container.textContent).not.toContain('Install Phosphor')
})
it('honestly handles dismissal, consumes the event, and permits a fresh browser offer', async () => {
  await render()
  const first = offer('dismissed')
  await act(async () => {
    window.dispatchEvent(first.event)
  })
  await click('Install Phosphor')
  expect(container.textContent).toContain('Not installed')
  const second = offer()
  await act(async () => {
    window.dispatchEvent(second.event)
  })
  await click('Install Phosphor')
  expect(first.prompt).toHaveBeenCalledOnce()
  expect(second.prompt).toHaveBeenCalledOnce()
})
it('falls back to instructions on browser errors without exposing raw exception text', async () => {
  await render()
  const { event } = offer('accepted', vi.fn().mockRejectedValue(new Error('private/browser/data')))
  await act(async () => {
    window.dispatchEvent(event)
  })
  await click('Install Phosphor')
  expect(document.querySelector('[role=dialog]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('private/browser/data')
})
it('does not offer installation in an already standalone window', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  await render()
  expect(container.querySelector('button')).toBeNull()
})
it('provides platform-specific fallback without promising that every browser supports a prompt', () => {
  expect(installInstructions('Android Chrome').join(' ')).toContain('Add to Home screen')
  expect(installInstructions('iPad').join(' ')).toContain('Safari')
  expect(installInstructions('Linux Firefox').join(' ')).toContain('If installation is not offered')
})
