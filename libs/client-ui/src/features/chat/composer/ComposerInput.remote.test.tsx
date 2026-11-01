// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ComposerInput } from './ComposerInput'
import { useSlashMenu } from './useSlashMenu'
vi.mock('./ComposerField', () => ({
  ComposerField: ({ onChange }: { onChange: (value: string, caret: number) => void }) => (
    <button onClick={() => onChange('@', 1)}>Mention</button>
  ),
}))
vi.mock('@/features/voice/DictateButton', () => ({ DictateButton: () => null }))
vi.mock('./SwarmSwitch', () => ({
  useSwarm: () => null,
  swarmLook: () => '',
  SwarmSwitch: () => <span>live swarm</span>,
  SwarmControl: () => <span>draft swarm</span>,
}))
it.each([
  ['/mac', 'host:machine/lane:lane-a', '/mac'],
  ['host:machine/lane:lane-a', 'host:machine/lane:lane-b', 'host:machine/lane:lane-a'],
])('file mentions and Mac-only controls follow target across %j', async (...sequence) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  const invoke = vi.fn(async (_channel, path) => [`${path.split('/').at(-1)}-only.ts`])
  vi.stubGlobal('phosphor', { invoke })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Harness({ workspacePath }: { workspacePath: string }) {
    const slash = useSlashMenu({ entries: [], setText: () => {}, focus: () => {} })
    return (
      <ComposerInput
        placeholder="Message"
        workspacePath={workspacePath}
        attachments={[]}
        onAttachmentsChange={() => {}}
        onWarning={() => {}}
        swarm={{ enabled: false, onChange: () => {} }}
        slash={slash}
        modelPicker={null}
        actions={null}
        value=""
        textareaRef={createRef()}
        onChange={() => {}}
        onSubmit={() => {}}
      />
    )
  }
  try {
    for (const workspacePath of sequence) {
      act(() => root.render(<Harness workspacePath={workspacePath} />))
      await act(async () => container.querySelector('button')!.click())
      expect(invoke).toHaveBeenLastCalledWith('fs:listFiles', workspacePath)
      expect(container.textContent).toContain(`${workspacePath.split('/').at(-1)}-only.ts`)
      if (workspacePath.startsWith('host:')) {
        expect(container.textContent).not.toContain('mac-only.ts')
        expect(container.querySelector('[aria-label="Attach files"]')).toBeNull()
      }
      // Swarm is a lane capability, not a Mac one: every target offers it.
      expect(container.textContent).toContain('draft swarm')
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it.each([
  ['a live Host lane', { sessionId: 'host:machine/lane:lane-a' }, 'live swarm'],
  ['a target that cannot offer it', null, null],
] as const)('Swarm on %s', (_name, swarm, shown) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => []) })
  const container = document.createElement('div')
  const root = createRoot(container)
  function Harness() {
    const slash = useSlashMenu({ entries: [], setText: () => {}, focus: () => {} })
    return (
      <ComposerInput
        placeholder="Message"
        workspacePath="host:machine/lane:lane-a"
        attachments={[]}
        onAttachmentsChange={() => {}}
        onWarning={() => {}}
        swarm={swarm}
        slash={slash}
        modelPicker={null}
        actions={null}
        value=""
        textareaRef={createRef()}
        onChange={() => {}}
        onSubmit={() => {}}
      />
    )
  }
  try {
    act(() => root.render(<Harness />))
    if (shown) expect(container.textContent).toContain(shown)
    else expect(container.textContent).not.toContain('swarm')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
