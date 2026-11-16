// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  WIDE_BROWSER_PLATFORM,
  PlatformProvider,
} from '@/platform/Platform'
import { ResponsiveDiff } from './ResponsiveDiff'
import { unifiedLines } from './unifiedLines'

afterEach(() => vi.unstubAllGlobals())

it('compares added, removed and unchanged lines in reading order', () => {
  expect(
    unifiedLines('header\nold\ncontext\ndeleted\nfooter', 'header\nnew\ncontext\nfooter'),
  ).toEqual([
    { kind: 'same', text: 'header' },
    { kind: 'removed', text: 'old' },
    { kind: 'added', text: 'new' },
    { kind: 'same', text: 'context' },
    { kind: 'removed', text: 'deleted' },
    { kind: 'same', text: 'footer' },
  ])
})
it('handles empty text, repeated lines, CRLF and final newlines', () => {
  expect(unifiedLines('', '')).toEqual([])
  expect(unifiedLines('', 'added')).toEqual([{ kind: 'added', text: 'added' }])
  expect(unifiedLines('removed', '')).toEqual([{ kind: 'removed', text: 'removed' }])
  expect(unifiedLines('x\r\nx\r\ny', 'x\ny')).toEqual([
    { kind: 'same', text: 'x' },
    { kind: 'removed', text: 'x' },
    { kind: 'same', text: 'y' },
  ])
  expect(unifiedLines('x', 'x\n')).toEqual([
    { kind: 'same', text: 'x' },
    { kind: 'added', text: '' },
  ])
})
it('bounds large unrelated comparisons while preserving every source line', () => {
  const a = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n')
  const b = Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n')
  const diff = unifiedLines(`header\n${a}\nfooter`, `header\n${b}\nfooter`)
  expect(
    diff
      .filter((line) => line.kind !== 'added')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(`header\n${a}\nfooter`)
  expect(
    diff
      .filter((line) => line.kind !== 'removed')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(`header\n${b}\nfooter`)
})
it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM, DESKTOP_PLATFORM])(
  '%s: only a phone draws escaped, wrapping line differences instead of mounting Monaco',
  (platform) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      act(() =>
        root.render(
          <PlatformProvider value={platform}>
            <ResponsiveDiff
              original="old"
              modified={'<script>new</script>'}
              editor={<div data-editor />}
            />
          </PlatformProvider>,
        ),
      )
      if (platform.formFactor === 'compact') {
        expect(container.querySelector('[data-editor]')).toBeNull()
        expect(container.querySelector('[aria-label="Removed"]')?.textContent).toBe('−')
        expect(container.querySelector('[aria-label="Added"]')?.textContent).toBe('+')
        expect(container.textContent).toContain('<script>new</script>')
        expect(container.querySelector('script')).toBeNull()
        expect(container.querySelector('.whitespace-pre-wrap')).not.toBeNull()
      } else expect(container.querySelector('[data-editor]')).not.toBeNull()
    } finally {
      act(() => root.unmount())
    }
  },
)
