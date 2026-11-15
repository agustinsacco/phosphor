// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  COMPACT_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
  type Platform,
} from '@/platform/Platform'
import { FileTextEditing } from './FileTextEditing'
import { SplitListDetail } from './ListDetail'
import { PlainTextEditor } from './PlainTextEditor'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)

function renderEditing(
  platform: Platform,
  props: Partial<Parameters<typeof FileTextEditing>[0]> = {},
) {
  const onChange = vi.fn()
  const onSave = vi.fn()
  const element = (extra: Partial<Parameters<typeof FileTextEditing>[0]>) => (
    <PlatformProvider value={platform}>
      <FileTextEditing
        id="a.ts"
        label="Edit a.ts"
        editor={<div data-editor />}
        reader={<pre>read view</pre>}
        value="text"
        dirty={false}
        readOnly={false}
        onChange={onChange}
        onSave={onSave}
        {...props}
        {...extra}
      />
    </PlatformProvider>
  )
  act(() => root.render(element({})))
  return { onChange, onSave, rerender: (extra = {}) => act(() => root.render(element(extra))) }
}

it('is the code editor anywhere but a phone', () => {
  renderEditing(WIDE_BROWSER_PLATFORM)
  expect(container.querySelector('[data-editor]')).not.toBeNull()
  expect(container.textContent).not.toContain('Edit')
})

it('a phone reads the file, and Edit swaps in a plain field over the same text', () => {
  const { onChange, onSave } = renderEditing(COMPACT_PLATFORM)
  expect(container.querySelector('[data-editor]')).toBeNull()
  expect(container.textContent).toContain('read view')
  act(() => button('Edit')!.click())
  const field = container.querySelector('textarea')!
  expect(field.value).toBe('text')
  expect(field.getAttribute('aria-label')).toBe('Edit a.ts')
  // No zoom on focus, and none of a keyboard's corrections to prose.
  expect(field.className).toContain('text-[16px]')
  expect(field.className).toContain('font-mono')
  expect(field.getAttribute('spellcheck')).toBe('false')
  expect(field.getAttribute('autocorrect')).toBe('off')
  expect(field.getAttribute('autocapitalize')).toBe('off')
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(field, 'typed')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onChange).toHaveBeenCalledWith('typed')
  act(() => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
  })
  expect(onSave).toHaveBeenCalledTimes(1)
  act(() => button('Done')!.click())
  expect(container.querySelector('textarea')).toBeNull()
})

it('a phone offers Save only while there are edits, and saves through the same path', () => {
  const { onSave, rerender } = renderEditing(COMPACT_PLATFORM)
  expect(button('Save')).toBeUndefined()
  rerender({ dirty: true })
  act(() => button('Save')!.click())
  expect(onSave).toHaveBeenCalledTimes(1)
})

it('a read-only file has no Edit, and a file going read only leaves editing', () => {
  const { rerender } = renderEditing(COMPACT_PLATFORM)
  act(() => button('Edit')!.click())
  rerender({ readOnly: true })
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.textContent).toContain('read view')
  expect(button('Edit')).toBeUndefined()
})

it('another file opens on its read view', () => {
  const { rerender } = renderEditing(COMPACT_PLATFORM)
  act(() => button('Edit')!.click())
  rerender({ id: 'b.ts' })
  expect(container.querySelector('textarea')).toBeNull()
})

it('SplitListDetail: a phone keeps the list mounted and hidden while the detail shows', () => {
  const onBack = vi.fn()
  const render = (platform: Platform, open: boolean) =>
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <SplitListDetail
            autoSaveId="test"
            list={<p>the list</p>}
            detail={(back) => <div data-detail>{back}</div>}
            open={open}
            onBack={onBack}
            backLabel="Files"
          />
        </PlatformProvider>,
      ),
    )
  render(COMPACT_PLATFORM, false)
  expect(container.querySelector('[data-detail]')).toBeNull()
  render(COMPACT_PLATFORM, true)
  expect(container.querySelector('p')?.closest('[hidden]')).not.toBeNull()
  act(() => button('← Files')!.click())
  expect(onBack).toHaveBeenCalledTimes(1)
  render(WIDE_BROWSER_PLATFORM, true)
  expect(container.querySelector('p')?.closest('[hidden]')).toBeNull()
  expect(container.querySelector('[data-detail]')?.textContent).toBe('')
  expect(container.querySelector('[data-panel-group]')).not.toBeNull()
})

it('PlainTextEditor: an edit goes back in the line ending the text had, as Monaco keeps it', () => {
  const sent: string[] = []
  function Field({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial)
    const onChange = (next: string) => {
      sent.push(next)
      setValue(next)
    }
    return <PlainTextEditor label="Edit" value={value} onChange={onChange} />
  }
  const field = () => container.querySelector('textarea')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const type = (text: string) =>
    act(() => {
      setValue.call(field(), text)
      field().dispatchEvent(new Event('input', { bubbles: true }))
    })
  act(() => root.render(<Field key="crlf" initial={'a\r\nb'} />))
  expect(field().value).toBe('a\nb')
  type('a\nbc')
  // Every line break gone, then a new one: the file is still CRLF.
  type('abc')
  type('ab\nc')
  expect(sent).toEqual(['a\r\nbc', 'abc', 'ab\r\nc'])
  act(() => root.render(<Field key="lf" initial={'a\nb'} />))
  type('a\nb\nc')
  expect(sent.at(-1)).toBe('a\nb\nc')
})
