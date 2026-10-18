// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFilesPane } from './RemoteFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoDiff: ({ modifiedText }: { modifiedText: string }) => <pre>{modifiedText}</pre>,
  MonacoEditor: ({ value, path }: { value: string; path: string }) => (
    <pre data-model={path}>{value}</pre>
  ),
}))
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])(
  'refreshes Files/Changes through Mac -> bee1 -> another repo -> bee1 -> Mac (changes=%s)',
  async (changes) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])
    if (!host) throw new Error('fixture')
    host.capabilities = ['workspaces.read']
    const a = {
      ...mockRemoteInfo,
      sessionId: 'remote-a',
      workspacePath: `host:${MOCK_HOST_ID}/lane:a`,
      phosphorId: 'remote-a',
    }
    const b = {
      ...mockRemoteInfo,
      sessionId: 'remote-b',
      workspacePath: `host:${MOCK_HOST_ID}/lane:b`,
      phosphorId: 'remote-b',
    }
    useSessionsStore.setState({ live: { [a.sessionId]: a, [b.sessionId]: b } })
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
    vi.stubGlobal('phosphor', {
      invoke: vi.fn(async (channel: string, path: string) => {
        if (channel === 'fs:listFiles') return ['src/same.ts']
        if (channel === 'git:statusMap') return { 'src/same.ts': ' M' }
        if (channel === 'git:showFileAt') return 'before'
        if (channel === 'fs:readFile')
          return {
            content: path.includes('lane:a') ? 'BEE1 A' : 'BEE1 B',
            revision: 'a'.repeat(64),
            binary: false,
          }
        throw new Error('unexpected local call')
      }),
    })
    const container = document.createElement('div'),
      root = createRoot(container)
    try {
      for (const target of [null, a, b, a, null]) {
        await act(async () =>
          root.render(
            target ? (
              <RemoteFilesPane
                workspacePath={target.workspacePath}
                sessionId={target.sessionId}
                changes={changes}
              />
            ) : (
              <div>MAC VIEW</div>
            ),
          ),
        )
        if (!target) {
          expect(container.textContent).toBe('MAC VIEW')
          continue
        }
        expect(container.textContent).not.toContain('MAC VIEW')
        expect(container.textContent).not.toContain('BEE1 A')
        expect(container.textContent).not.toContain('BEE1 B')
        const button = [...container.querySelectorAll('button')].find((b) =>
          b.textContent?.includes('same.ts'),
        )
        await act(async () => button?.click())
        expect(container.textContent).toContain(target === a ? 'BEE1 A' : 'BEE1 B')
        expect(container.textContent).not.toContain(target === a ? 'BEE1 B' : 'BEE1 A')
        if (!changes)
          expect(container.querySelector('[data-model]')?.getAttribute('data-model')).toBe(
            `remote:${target.sessionId}/src/same.ts`,
          )
      }
    } finally {
      act(() => root.unmount())
    }
  },
)
