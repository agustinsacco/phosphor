// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MachineDetailHeader } from './MachineDetailHeader'
import { MACHINE } from './__fixtures__/control'

it('moves keyboard focus into maintenance and restores it when Escape dismisses the popup', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <MachineDetailHeader
          machine={{ ...MACHINE, endpoint: 'https://fixture.ts.net' }}
          headline={{ label: 'Connected', tone: 'ok', detail: 'Ready' }}
          now={Date.now()}
          checking={false}
          reconnecting={false}
          onCheck={vi.fn()}
          onReconnect={vi.fn()}
        />,
      ),
    )
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="Machine actions"]')!
    trigger.focus()
    await act(async () => trigger.click())
    expect(document.activeElement?.textContent).toBe('Reconnect')
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(document.activeElement).toBe(trigger)
    expect(
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Check again',
      ),
    ).toBe(false)
  } finally {
    await act(async () => root.unmount())
    element.remove()
  }
})
