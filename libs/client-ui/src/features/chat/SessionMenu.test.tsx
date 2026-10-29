// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcCommand } from '@shared/rpc'
import { ContextMenuHost } from '@/components/ContextMenu'
import { useChatStore } from '@/stores/chat'
import { usePromptStore } from '@/stores/prompt'
import { useSessionsStore } from '@/stores/sessions'
import { SessionMenu } from './SessionMenu'

const SESSION = 'local-session'
const piCommand = vi.fn(async (_id: string, command: RpcCommand) =>
  command.type === 'export_html'
    ? { success: true, data: { path: '/tmp/out.html' } }
    : { success: true },
)
const invoke = vi.fn(async (channel: string) =>
  channel === 'app:saveDialog' ? '/tmp/out.html' : undefined,
)
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, piCommand })
  piCommand.mockClear()
  invoke.mockClear()
  useSessionsStore.setState({ live: { [SESSION]: { phosphorId: SESSION, workspacePath: '/w' } } })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(SESSION)
  useChatStore.getState().setMeta(SESSION, {
    sessionId: SESSION,
    sessionName: 'Local work',
    isStreaming: false,
    isCompacting: false,
    thinkingLevel: 'off',
    steeringMode: 'all',
    followUpMode: 'all',
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  })
  usePromptStore.setState({ requests: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root.render(
      <>
        <SessionMenu sessionId={SESSION} />
        <ContextMenuHost />
      </>,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll('button')]
const trigger = (): HTMLButtonElement =>
  buttons().find((b) => b.getAttribute('aria-label') === 'Session options')!
const row = (label: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b !== trigger() && b.textContent?.startsWith(label))
/** Opens the menu unless it is already open (toggles may keep it open). */
function open(): void {
  if (!row('Auto-retry')) act(() => trigger().click())
}
async function choose(label: string): Promise<void> {
  open()
  await act(async () => row(label)!.click())
}

it('lists export, compaction, retry and queue modes for a local session (characterize)', () => {
  expect(trigger()).toBeDefined()
  open()
  for (const label of [
    'Export HTML…',
    'Compact now…',
    'Auto-compaction',
    'Auto-retry',
    'Steering',
    'Follow-ups',
  ])
    expect(row(label), label).toBeDefined()
})

it('sends each setting to pi and records it on the session (characterize)', async () => {
  await choose('Auto-compaction')
  expect(piCommand).toHaveBeenLastCalledWith(SESSION, {
    type: 'set_auto_compaction',
    enabled: false,
  })
  expect(useChatStore.getState().sessions[SESSION]!.meta!.autoCompactionEnabled).toBe(false)
  await choose('Auto-retry')
  expect(piCommand).toHaveBeenLastCalledWith(SESSION, { type: 'set_auto_retry', enabled: false })
  await choose('Steering')
  expect(piCommand).toHaveBeenLastCalledWith(SESSION, {
    type: 'set_steering_mode',
    mode: 'one-at-a-time',
  })
  expect(useChatStore.getState().sessions[SESSION]!.meta!.steeringMode).toBe('one-at-a-time')
  await choose('Follow-ups')
  expect(piCommand).toHaveBeenLastCalledWith(SESSION, {
    type: 'set_follow_up_mode',
    mode: 'one-at-a-time',
  })
  expect(useChatStore.getState().sessions[SESSION]!.meta!.followUpMode).toBe('one-at-a-time')
})

it('compacts with the instructions typed into the prompt (characterize)', async () => {
  await choose('Compact now…')
  const request = usePromptStore.getState().requests[0]!
  expect(request.title).toBe('Compact context now')
  await act(async () => usePromptStore.getState().dismiss(request, 'keep the plan'))
  expect(piCommand).toHaveBeenLastCalledWith(SESSION, {
    type: 'compact',
    customInstructions: 'keep the plan',
  })
})

it('exports HTML to the chosen path and reveals it (characterize)', async () => {
  await choose('Export HTML…')
  expect(invoke).toHaveBeenCalledWith(
    'app:saveDialog',
    expect.objectContaining({ defaultPath: 'Local work.html' }),
  )
  expect(piCommand).toHaveBeenLastCalledWith(SESSION, {
    type: 'export_html',
    outputPath: '/tmp/out.html',
  })
  expect(invoke).toHaveBeenLastCalledWith('app:revealPath', '/tmp/out.html')
})
