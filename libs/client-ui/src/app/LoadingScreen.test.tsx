// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LoadingScreen } from './LoadingScreen'
import { TooltipProvider } from '@/components/Tooltip'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const container = document.createElement('div')
const root = createRoot(container)
afterEach(async () => {
  await act(async () => root.unmount())
  container.replaceChildren()
  vi.unstubAllGlobals()
})

it('characterizes shared startup status and explicit error recovery', async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <LoadingScreen message="Checking your session…" />
      </TooltipProvider>,
    ),
  )
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Checking your session…')
  expect(container.querySelector('h1')?.textContent).toBe('Phosphor')
  expect(container.querySelector('button')).toBeNull()
  const retry = vi.fn()
  await act(async () =>
    root.render(
      <TooltipProvider>
        <LoadingScreen error="Connection unavailable." onRetry={retry} />
      </TooltipProvider>,
    ),
  )
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connection unavailable.')
  await act(async () => container.querySelector('button')?.click())
  expect(retry).toHaveBeenCalledOnce()
})
