// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import type { ChatItem } from '@/features/chat/chatItems'
import { useChatStore } from '@/stores/chat'
import { useDraftsStore, sessionDraftKey } from '@/stores/drafts'
import { useSessionsStore } from '@/stores/sessions'
import { LaneSlackThreads } from './LaneSlackThreads'

const ROOT = 'https://acme.slack.com/archives/C0123ABC/p1730563200123456'
const OTHER = 'https://acme.slack.com/archives/C0999/p1730000000000001'
let root: Root
let container: HTMLDivElement
let restore: () => void
let dispose: () => void
const external = vi.fn(async (_url: string) => {})
const pill = (): HTMLButtonElement | null =>
  container.querySelector('[data-testid="lane-slack-threads"]')
const byLabel = (prefix: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label')?.startsWith(prefix),
  )!
const rows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-testid="slack-thread-open"]'),
]

function transcript(...texts: string[]): void {
  const items: ChatItem[] = texts.map((text, i) => ({ id: `u${i}`, kind: 'user', text }))
  useChatStore.setState({ sessions: { a: { items } } } as never)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSessionsStore.setState({ live: { a: { phosphorId: 'a', workspacePath: '/repo/wt' } } })
  useDraftsStore.setState({ drafts: {}, revisions: {} })
  useChatStore.setState({ sessions: {} })
  external.mockReset().mockResolvedValue(undefined)
  const fake = createFakePhosphor({ 'app:openExternal': external })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('stays hidden until the transcript mentions a Slack thread, then appears', async () => {
  transcript('no links here', 'https://github.com/x/y/pull/1')
  await act(async () => root.render(<LaneSlackThreads sessionId="a" />))
  expect(pill()).toBeNull()
  await act(async () => transcript('no links here', `please read ${ROOT}`))
  expect(pill()?.getAttribute('aria-label')).toBe('1 Slack thread in context')
  expect(pill()?.querySelector('svg path[fill="#E01E5A"]')).not.toBeNull()
  expect(pill()?.textContent).toBe('')
})

it('counts several threads, opens one with focus inside, and Escape restores focus', async () => {
  transcript(`ask in ${ROOT}`, `see also ${OTHER}`)
  await act(async () => root.render(<LaneSlackThreads sessionId="a" />))
  expect(pill()?.textContent).toBe('2')
  pill()!.focus()
  await act(async () => pill()!.click())
  expect(rows()).toHaveLength(2)
  expect(document.activeElement).toBe(rows()[0])
  expect(rows()[0]?.textContent).toContain('ask in')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(rows()).toHaveLength(0)
  expect(document.activeElement).toBe(pill())
})

it('opens the rebuilt link, and reports a failure without closing', async () => {
  transcript(`${ROOT}?thread_ts=junk#frag`)
  await act(async () => root.render(<LaneSlackThreads sessionId="a" />))
  await act(async () => pill()!.click())
  external.mockRejectedValueOnce(new Error('denied'))
  await act(async () => rows()[0]!.click())
  expect(external).toHaveBeenCalledWith(ROOT)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not open Slack')
  await act(async () => rows()[0]!.click())
  expect(rows()).toHaveLength(0)
})

it('adds a thread to the unsent message without replacing it, and focuses the composer', async () => {
  const field = document.createElement('textarea')
  field.setAttribute('data-composer-input', '')
  document.body.append(field)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => cb(0))
  const key = sessionDraftKey(undefined, 'a')
  useDraftsStore.getState().setText(key, 'compare with')
  transcript(`ask in ${ROOT}`)
  await act(async () => root.render(<LaneSlackThreads sessionId="a" />))
  await act(async () => pill()!.click())
  await act(async () => byLabel('Add ').click())
  expect(useDraftsStore.getState().get(key).text).toBe(`compare with ${ROOT} `)
  expect(rows()).toHaveLength(0)
  expect(document.activeElement).toBe(field)
  field.remove()
})

it('copies the link', async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  transcript(ROOT)
  await act(async () => root.render(<LaneSlackThreads sessionId="a" />))
  await act(async () => pill()!.click())
  await act(async () => byLabel('Copy link').click())
  expect(writeText).toHaveBeenCalledWith(ROOT)
})
