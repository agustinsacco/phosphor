// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FindBar } from '@/components/search/FindBar'
import { openTranscriptFindForFocus } from '@/components/search/findTargets'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { sessionMenuItems } from './sessionMenuItems'
import { requestChatFind, useChatFind, useChatFindRequest } from './useChatFind'

let root: Root
let el: HTMLDivElement
const step = vi.fn()
function Transcript({ sessionId }: { sessionId: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const find = useChatFind(sessionId, ref)
  return (
    <div ref={ref} data-testid="transcript" tabIndex={-1}>
      <FindBar find={find} total={3} active={0} onStep={step} placeholder="Find in session" />
    </div>
  )
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList)
  step.mockReset()
  useChatFindRequest.setState({ sessionId: null })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  useChatFindRequest.setState({ sessionId: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('the menu opens compact find without lane control and Enter steps to the next match', () => {
  const items = sessionMenuItems({
    sessionId: 'chat',
    nativeFiles: false,
    meta: undefined,
    controlHint: 'Take control first.',
  })
  const item = items.find((entry) => entry.label === 'Find in chat')!
  expect(item.disabled).toBeUndefined()
  // A request made from Files waits for its own transcript, not another lane's.
  act(() => item.onClick?.())
  act(() => root.render(<Transcript sessionId="other" />))
  expect(el.querySelector('[data-find-bar]')).toBeNull()
  act(() =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <Transcript sessionId="chat" />
      </PlatformProvider>,
    ),
  )
  const bar = el.querySelector('[data-find-bar]')!
  expect(bar.hasAttribute('data-compact-find')).toBe(true)
  const input = bar.querySelector('input')!
  expect(document.activeElement).toBe(input)
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    ),
  )
  expect(step).toHaveBeenLastCalledWith(1)
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  )
  expect(step).toHaveBeenLastCalledWith(-1)
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  )
  expect(el.querySelector('[data-find-bar]')).toBeNull()
})
it('browser focus routing takes only a visible transcript, never Desktop fallback elsewhere', () => {
  act(() =>
    root.render(
      <>
        <input aria-label="Elsewhere" />
        <Transcript sessionId="chat" />
      </>,
    ),
  )
  el.querySelector<HTMLInputElement>('input')!.focus()
  expect(openTranscriptFindForFocus()).toBe(false)
  el.querySelector<HTMLElement>('[data-testid="transcript"]')!.focus()
  act(() => {
    expect(openTranscriptFindForFocus()).toBe(true)
  })
  expect(el.querySelector('[data-find-bar]')).not.toBeNull()
})
it('repeated menu requests re-focus an already open transcript bar', () => {
  act(() => root.render(<Transcript sessionId="chat" />))
  act(() => requestChatFind('chat'))
  const input = el.querySelector('input')!
  expect(document.activeElement).toBe(input)
  input.blur()
  act(() => requestChatFind('chat'))
  expect(document.activeElement).toBe(input)
})
