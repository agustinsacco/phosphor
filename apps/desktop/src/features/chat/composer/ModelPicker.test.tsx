// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Model } from '@shared/rpc'
import type { HostsSnapshot } from '@shared/ipc'
import { ModelPicker } from './ModelPicker'
import { useChatStore } from '@/stores/chat'
import { useModelPicksStore } from '@/stores/modelPicks'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

// jsdom has no layout engine, so MenuRow's scroll-into-view call is a no-op here.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const SESSION = 'sess-1'

const model = (provider: string, id: string, name: string): Model => ({
  id,
  name,
  api: provider,
  provider,
  reasoning: true,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
})

const CODEX = model('openai-codex', 'gpt-5', 'GPT-5')
const CLAUDE = model('pi-claude-cli', 'claude-haiku-4-5', 'Claude Haiku 4.5')

const invoke = vi.fn(async () => undefined)
const piCommand = vi.fn()

beforeEach(() => {
  invoke.mockClear()
  piCommand.mockReset()
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = {
    invoke,
    piCommand,
  }
  useModelPicksStore.setState({ starred: [], recent: [], groupMode: 'family', hydrated: true })
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(SESSION)
  useChatStore.getState().setModels(SESSION, [CODEX, CLAUDE])
  useChatStore.getState().setMeta(SESSION, {
    model: CODEX,
    thinkingLevel: 'medium',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    sessionId: SESSION,
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  })
})

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ModelPicker sessionId={SESSION} />))
}

function chip(): HTMLButtonElement {
  const el = document.querySelector('[data-testid="model-chip"]')
  if (!el) throw new Error('no model chip')
  return el as HTMLButtonElement
}

/** Open the menu and click a model's row, which carries `provider/id` as its title. */
function pick(target: Model): void {
  act(() => chip().click())
  const key = `${target.provider}/${target.id}`
  const row = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="model-row"]')].find(
    (r) => r.dataset.tooltip! === key,
  )
  if (!row) throw new Error(`no row for ${key}`)
  act(() => row.click())
}

describe('ModelPicker', () => {
  it.each(['stopped', 'failed'] as const)(
    'keeps the %s lane model isolated across A -> B -> A',
    (activity) => {
      const hosts: HostsSnapshot = structuredClone(mockRemoteHosts)
      const lane = {
        ...hosts[MOCK_HOST_ID]!.lanes[0]!,
        activity,
        model: { provider: CLAUDE.provider, id: CLAUDE.id },
      }
      hosts[MOCK_HOST_ID]!.lanes = [lane]
      const remoteId = mockRemoteInfo.sessionId
      useRemoteLanesStore.setState({ hosts })
      useSessionsStore.setState({
        live: {
          [remoteId]: {
            phosphorId: remoteId,
            workspacePath: mockRemoteInfo.workspacePath,
            target: { kind: 'remote', hostId: MOCK_HOST_ID },
            laneId: lane.laneId,
          },
        },
      })
      render()
      expect(chip().textContent).toContain(CODEX.name)
      act(() => root!.render(<ModelPicker sessionId={remoteId} />))
      expect(chip().textContent).toContain(CLAUDE.id)
      expect(chip().textContent).not.toContain(CODEX.name)
      // A summary can arrive before refreshed pi metadata. Never render the
      // stale model's name under the newly selected model's identity.
      act(() => {
        useChatStore.getState().ensure(remoteId)
        useChatStore.getState().setMeta(remoteId, useChatStore.getState().sessions[SESSION]!.meta!)
      })
      expect(chip().textContent).toContain(CLAUDE.id)
      expect(chip().textContent).not.toContain(CODEX.name)
      act(() => root!.render(<ModelPicker sessionId={SESSION} />))
      expect(chip().textContent).toContain(CODEX.name)
      act(() => root!.render(<ModelPicker sessionId={remoteId} />))
      expect(chip().textContent).toContain(CLAUDE.id)
    },
  )

  it('does not carry an in-flight model name into another lane', async () => {
    const other = 'other-lane'
    useChatStore.getState().ensure(other)
    useChatStore.getState().setMeta(other, useChatStore.getState().sessions[SESSION]!.meta!)
    let finish: (value: unknown) => void = () => {}
    piCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    render()
    pick(CLAUDE)
    expect(chip().textContent).toContain(`Switching to ${CLAUDE.name}`)
    act(() => root!.render(<ModelPicker sessionId={other} />))
    expect(chip().textContent).toContain(CODEX.name)
    expect(chip().textContent).not.toContain(CLAUDE.name)
    await act(async () => {
      finish({ success: false, error: 'unavailable' })
    })
  })

  it('reports why main refused a switch, without the IPC wrapper', async () => {
    const reason =
      'Claude sessions need @saccolabs/pi-claude-cli 0.10.0 or newer (found 0.9.1). ' +
      'Update it in Settings → Extensions, then reopen the session.'
    piCommand.mockRejectedValue(
      new Error(`Error invoking remote method 'pi:command': Error: ${reason}`),
    )
    render()
    pick(CLAUDE)
    await vi.waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.error).toBe(reason))
    expect(piCommand).toHaveBeenCalledExactlyOnceWith(SESSION, {
      type: 'set_model',
      provider: CLAUDE.provider,
      modelId: CLAUDE.id,
    })
    // Settled back on the model the session still runs, and clickable again.
    await vi.waitFor(() => expect(chip().disabled).toBe(false))
    expect(chip().textContent).toContain(CODEX.name)
  })
})

it.each([
  [SESSION, 'bee1-a', SESSION],
  ['bee1-a', 'bee1-b', 'bee1-a'],
])('model/thinking menu stays session-scoped on %j switches', (...sequence) => {
  const base = useChatStore.getState().sessions[SESSION]!.meta!
  for (const [id, chosen] of [
    ['bee1-a', CLAUDE],
    ['bee1-b', { ...CODEX, id: 'other-model', name: 'Other repo model', reasoning: false }],
  ] as const) {
    useChatStore.getState().ensure(id)
    useChatStore.getState().setMeta(id, { ...base, model: chosen, thinkingLevel: 'off' })
    useChatStore.getState().setModels(id, [chosen])
  }
  render()
  for (const id of sequence) {
    act(() => root!.render(<ModelPicker key={id} sessionId={id} />))
    const name =
      id === SESSION ? 'GPT-5' : id === 'bee1-a' ? 'Claude Haiku 4.5' : 'Other repo model'
    expect(chip().textContent).toContain(name)
    act(() => chip().click())
    const rows = [...document.querySelectorAll('[data-testid=model-row]')]
      .map((row) => row.textContent)
      .join(' ')
    expect(rows).toContain(name)
    if (id === 'bee1-b') expect(rows).not.toContain('Claude Haiku')
    act(() => chip().click())
  }
})
