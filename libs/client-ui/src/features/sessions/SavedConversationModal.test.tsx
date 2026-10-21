// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { openSidebarConversation, useSavedConversation } from './completionActions'
import { SavedConversationModal } from './SavedConversationModal'

vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
}))
let root: Root | undefined
let dispose: (() => void) | undefined
let restore: (() => void) | undefined
afterEach(() => {
  act(() => root?.unmount())
  useSavedConversation.setState({ meta: null })
  restore?.()
  dispose?.()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it('recovers a failed first read without restoring or resuming, and closes with Escape', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('Temporary read failure'))
    .mockResolvedValueOnce([
      { role: 'user', content: 'Saved question' },
      { role: 'assistant', content: [{ type: 'text', text: 'Saved answer' }] },
      { role: 'custom', display: false, content: 'Hidden receipt' },
    ])
  const fake = createFakePhosphor({ 'sessions:readTranscript': read })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
  openSidebarConversation('/repo', {
    path: '/sessions/old.jsonl',
    name: 'Legacy lane',
    worktreeRemoved: true,
  } as SessionMeta)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<SavedConversationModal />))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Temporary read failure')
  const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
  await act(async () => retry.click())
  expect(document.body.textContent).toContain('Saved question')
  expect(document.body.textContent).toContain('Saved answer')
  expect(document.body.textContent).not.toContain('Hidden receipt')
  expect(document.querySelector('textarea')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenLastCalledWith('/sessions/old.jsonl')
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
