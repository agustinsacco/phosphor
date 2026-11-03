// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MachineDetailHeader } from './MachineDetailHeader'
import { MACHINE } from './__fixtures__/control'
import { hostSummary } from './machineOverview'

it('moves keyboard focus into maintenance and restores it when Escape dismisses the popup', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <MachineDetailHeader
          overview={{
            ...hostSummary(
              { ...MACHINE, endpoint: 'https://fixture.ts.net' },
              undefined,
              Date.now(),
              0,
            ),
            about: 'Linux x64',
            checks: [],
            facts: [],
            connected: true,
            check: { busy: false, at: null, round: 0, run: vi.fn() },
            reconnect: { busy: false, run: vi.fn() },
          }}
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
