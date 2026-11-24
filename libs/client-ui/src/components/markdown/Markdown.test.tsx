// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { NavigationProvider } from '@/navigation/Navigation'
import { UserText } from '@/features/chat/UserText'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

vi.mock('./CodeBlock', () => ({ CodeBlock: () => null, InlineCode: () => null }))
vi.mock('./MermaidBlock', () => ({ MermaidBlock: () => null }))
vi.mock('./ChartBlock', () => ({ ChartBlock: () => null }))
vi.mock('./VegaLiteBlock', () => ({ VegaLiteBlock: () => null }))
vi.mock('./HtmlBlock', () => ({ HtmlBlock: () => null }))

it('does not resolve unverified child paths or artifact IDs in the parent namespace', () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const el = document.createElement('div')
  const root = createRoot(el)
  const text = '[source](./src/index.ts) [saved](artifact://report) [web](https://example.com)'
  try {
    act(() => root.render(<Markdown text={text} inAppLinks={false} />))
    expect(el.textContent).toContain('source saved web')
    expect(el.querySelectorAll('a')).toHaveLength(1)
    expect(el.querySelector('a')?.href).toBe('https://example.com/')
    act(() => root.render(<Markdown text={text} />))
    expect(el.querySelectorAll('a')).toHaveLength(3)
  } finally {
    act(() => root.unmount())
  }
})

it('renders sent and Markdown mentions as lane chips and navigates via the current connection', () => {
  const navigate = vi.fn()
  const markdown = 'See [@On \\[Mac\\]](phosphor-lane:host:enrolled/lane:lane-id).'
  useRemoteLanesStore.setState({
    hosts: {
      socket: {
        ...mockRemoteHosts[MOCK_HOST_ID]!,
        local: true,
        enrolledHostId: 'enrolled',
        lanes: [{ ...mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!, laneId: 'lane-id' }],
      },
    },
  })
  const el = document.createElement('div')
  const root = createRoot(el)
  try {
    for (const ui of [<UserText text={markdown} />, <Markdown text={markdown} />]) {
      act(() =>
        root.render(
          <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
            {ui}
          </NavigationProvider>,
        ),
      )
      const chip = el.querySelector<HTMLElement>('[data-tooltip="Open lane"]')
      expect(chip?.textContent).toBe('@On [Mac]')
      expect(chip?.hasAttribute('href')).toBe(false)
      act(() => chip!.click())
      expect(navigate).toHaveBeenCalledWith({
        to: 'lane',
        lane: { hostId: 'socket', laneId: 'lane-id' },
        pane: 'chat',
      })
      navigate.mockClear()
    }
  } finally {
    act(() => root.unmount())
  }
})
