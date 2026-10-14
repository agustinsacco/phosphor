// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

const counts: Record<string, number> = {}
function counted(name: string, mod: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...mod }
  const C = mod[name] as (p: object) => React.JSX.Element
  out[name] = (p: object) => {
    counts[name] = (counts[name] ?? 0) + 1
    return C(p)
  }
  return out
}
vi.mock('./BackgroundWorkIndicator', async (orig) =>
  counted('BackgroundWorkIndicator', await orig()),
)
vi.mock('./WorkingIndicator', async (orig) => counted('WorkingIndicator', await orig()))
vi.mock('./composer/ContextMeter', async (orig) => counted('ContextMeter', await orig()))
vi.mock('./composer/ModelPicker', async (orig) => counted('ModelPicker', await orig()))

const { installMockPhosphor } = await import('@/dev/mockPhosphor')
installMockPhosphor()
const { useChatStore } = await import('@/stores/chat')
const { useDraftsStore, sessionDraftKey } = await import('@/stores/drafts')
const { Composer } = await import('./Composer')

/*
 * A keystroke must re-render the field, not every strip around it. They read
 * the chat store themselves, and while a turn streams, rendering them again on
 * every key competed with the transcript for the same frames.
 */
it('typing re-renders none of the strips and readouts around the field', async () => {
  useChatStore.getState().ensure('s1')
  useChatStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      s1: {
        ...s.sessions.s1!,
        isStreaming: true,
        agentStartedAt: Date.now(),
        items: [
          { id: 'u1', kind: 'user', text: 'hi' },
          {
            id: 'a1',
            kind: 'assistant',
            blocks: [{ type: 'text', text: 'hello' }],
            streaming: true,
          },
        ] as never,
      },
    },
  }))
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(<Composer sessionId="s1" workspacePath="/tmp/w" />))
  for (const k of Object.keys(counts)) counts[k] = 0
  for (const t of ['a', 'ab', 'abc', 'abc d', 'abc de']) {
    await act(async () => useDraftsStore.getState().setText(sessionDraftKey(undefined, 's1'), t))
  }
  expect(counts).toEqual({
    BackgroundWorkIndicator: 0,
    WorkingIndicator: 0,
    ContextMeter: 0,
    ModelPicker: 0,
  })
  expect((el.querySelector('[data-composer-input]') as HTMLTextAreaElement | null)?.value).toBe(
    'abc de',
  )
  root.unmount()
})
