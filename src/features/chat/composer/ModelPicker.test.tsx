// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Model } from '@shared/rpc'
import { ModelPicker } from './ModelPicker'
import { useChatStore } from '@/stores/chat'
import { useModelPicksStore } from '@/stores/modelPicks'

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
    (r) => r.title === key,
  )
  if (!row) throw new Error(`no row for ${key}`)
  act(() => row.click())
}

describe('ModelPicker', () => {
  it('reports why main refused a switch, without the IPC wrapper', async () => {
    const reason =
      'Claude sessions need @saccolabs/pi-claude-cli 0.9.0 or newer (found 0.8.3). ' +
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
