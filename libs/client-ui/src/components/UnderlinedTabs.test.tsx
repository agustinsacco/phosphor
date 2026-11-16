// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { UnderlinedTabs } from './UnderlinedTabs'

it('keeps tab semantics and roving focus through arrows, Home and End', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Harness(): React.JSX.Element {
    const [value, setValue] = useState('knowledge')
    return (
      <UnderlinedTabs
        id="brain"
        label="Brain views"
        value={value}
        onChange={setValue}
        tabs={[
          { value: 'knowledge', label: 'Knowledge' },
          { value: 'lanes', label: 'Lanes' },
        ]}
      />
    )
  }
  try {
    await act(async () => root.render(<Harness />))
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Brain views',
    )
    for (const [key, index] of [
      ['End', 1],
      ['ArrowRight', 0],
      ['ArrowLeft', 1],
      ['Home', 0],
    ] as const) {
      const current = tabs.find((tab) => tab.tabIndex === 0)!
      await act(async () =>
        current.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      )
      expect(document.activeElement).toBe(tabs[index])
      expect(tabs[index]?.getAttribute('aria-selected')).toBe('true')
      expect(tabs[index]?.getAttribute('aria-controls')).toBe(
        `brain-panel-${index ? 'lanes' : 'knowledge'}`,
      )
      expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[index]])
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
