// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PageLinks } from './PageLinks'

it('puts Brain directly below Machines and opens it using the shared page action', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  const onPage = vi.fn()
  try {
    await act(async () => root.render(<PageLinks activePage="brain" onPage={onPage} />))
    const buttons = [...container.querySelectorAll('button')]
    const machines = buttons.findIndex((b) => b.textContent === 'Machines')
    expect(buttons[machines + 1]!.textContent).toBe('Brain')
    await act(async () => buttons[machines + 1]!.click())
    expect(onPage).toHaveBeenCalledWith('brain')
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
