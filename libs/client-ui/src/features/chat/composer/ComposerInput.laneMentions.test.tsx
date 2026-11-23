// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { SessionMeta } from '@phosphor/shared/models'
import { ComposerInput } from './ComposerInput'
import type { ComposerFieldProps } from './ComposerField'
import { useSlashMenu } from './useSlashMenu'

vi.mock('./ComposerField', () => ({
  ComposerField: ({ onChange, onKeyDown, value }: ComposerFieldProps) => (
    <>
      <button onClick={() => onChange('Ask @ next', 5)}>Mention</button>
      <textarea
        readOnly
        value={value}
        onKeyDown={(event) => {
          onKeyDown?.(event)
        }}
      />
    </>
  ),
}))
vi.mock('@/features/voice/DictateButton', () => ({ DictateButton: () => null }))

const fileSource = { key: 'files', list: async () => ['src/demo.ts'] }
function Harness() {
  const [value, setValue] = useState('')
  return (
    <ComposerInput
      value={value}
      onChange={setValue}
      textareaRef={useRef(null)}
      placeholder="Message"
      onSubmit={() => {}}
      attachments={[]}
      onAttachmentsChange={() => {}}
      onWarning={() => {}}
      swarm={null}
      fileSource={fileSource}
      modelPicker={null}
      actions={null}
      slash={useSlashMenu({ entries: [], setText: setValue, focus: () => {} })}
    />
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})
it('keeps files first and inserts one stable ref for a saved lane or a connected machine', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  const lane = host.lanes[0]!
  useRemoteLanesStore.setState({
    hosts: {
      socket: {
        ...host,
        local: true,
        enrolledHostId: 'enrolled',
        lanes: [{ ...lane, title: 'On [Mac]' }],
      },
      bee: { ...host, lanes: [{ ...lane, title: 'On bee' }] },
      down: { ...host, state: 'reconnecting', lanes: [{ ...lane, title: 'Offline' }] },
      private: { ...host, capabilities: [], lanes: [{ ...lane, title: 'No access' }] },
    },
  })
  useSessionsStore.setState({
    disk: {
      '/repo': [{ path: '/fixture.jsonl', sessionId: 'pi-id', name: 'Saved' } as SessionMeta],
    },
  })
  const el = document.createElement('div')
  const root = createRoot(el)
  try {
    act(() => root.render(<Harness />))
    const open = async () => {
      await act(async () => el.querySelector('button:last-of-type')?.click())
    }
    await open()
    const menu = el.querySelector('[data-popup-menu]')!
    expect(menu.textContent).toMatch(/src\/demo.tsLanes/)
    expect(menu.textContent).not.toMatch(/Offline|No access/)
    const rows = [...menu.querySelectorAll('button')]
    expect(rows.map((r) => r.textContent)).toEqual([
      'src/demo.ts',
      expect.stringContaining('Saved'),
      expect.stringContaining('On [Mac]'),
      expect.stringContaining('On bee'),
    ])
    const textarea = el.querySelector('textarea')!
    for (const key of ['ArrowDown', 'ArrowDown', 'Tab'])
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    expect(textarea.value).toBe(
      `Ask [@On \\[Mac\\]](phosphor-lane:host:enrolled/lane:${lane.laneId}) next`,
    )
    for (const [label, ref] of [
      ['Saved', 'local/session:pi-id'],
      ['On bee', `host:bee/lane:${lane.laneId}`],
    ]) {
      await open()
      act(() =>
        [...el.querySelectorAll<HTMLButtonElement>('[data-popup-menu] button')]
          .find((b) => b.textContent?.includes(label!))!
          .click(),
      )
      expect(textarea.value).toBe(`Ask [@${label}](phosphor-lane:${ref}) next`)
    }
  } finally {
    act(() => root.unmount())
  }
})
