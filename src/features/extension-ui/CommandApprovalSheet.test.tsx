// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionUIRequest } from '@shared/rpc'

window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia

const { ExtensionDialogHost } = await import('./ExtensionUiHosts')
const { useExtensionUiStore } = await import('@/stores/extensionUi')

let root: Root | null = null
let container: HTMLDivElement | null = null
let invoke: ReturnType<typeof vi.fn>

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<ExtensionDialogHost />)
  })
}

function enqueue(request: ExtensionUIRequest): void {
  act(() => useExtensionUiStore.getState().handleRequest('session-1', request))
}

function click(label: string): void {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )
  expect(button, `no button labelled ${label}`).toBeTruthy()
  act(() => button!.click())
}

/** The prose a permission-gate extension sends for a dangerous bash call. */
function gate(command: string): ExtensionUIRequest {
  return {
    type: 'extension_ui_request',
    id: 'req-1',
    method: 'select',
    title: `Dangerous command:\n\n  ${command}\n\nAllow?`,
    options: ['Yes', 'No'],
  }
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(undefined)
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = { invoke }
  useExtensionUiStore.setState({ dialogs: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

describe('ExtensionDialogHost / command approval', () => {
  it('explains the risk instead of dumping the prose as a title', () => {
    render()
    enqueue(gate('rm -rf /tmp/build'))
    const text = document.body.textContent ?? ''
    expect(text).toContain('Run this command?')
    expect(text).toContain('Deletes files and directories recursively')
    // The gate's own scaffolding is replaced, not echoed.
    expect(text).not.toContain('Allow?')
  })

  it('answers with the option string the gate offered', () => {
    render()
    enqueue(gate('rm -rf /tmp/build'))
    click('Allow')
    expect(invoke).toHaveBeenCalledWith('pi:extensionUiResponse', 'session-1', {
      type: 'extension_ui_response',
      id: 'req-1',
      value: 'Yes',
    })
    expect(useExtensionUiStore.getState().dialogs).toHaveLength(0)
  })

  it('denies with the gate’s no option', () => {
    render()
    enqueue(gate('sudo reboot'))
    click('Deny')
    expect(invoke).toHaveBeenCalledWith('pi:extensionUiResponse', 'session-1', {
      type: 'extension_ui_response',
      id: 'req-1',
      value: 'No',
    })
  })

  it('says when every match is written text rather than a command', () => {
    render()
    enqueue(gate("cat > s.sh <<'EOF'\nrm -rf /tmp/x\nEOF\necho done"))
    expect(document.body.textContent).toContain('written to a file here, not run')
  })

  it('folds a long command down to the flagged lines', () => {
    const command = Array.from({ length: 40 }, (_, i) =>
      i === 20 ? 'rm -rf /tmp/x' : `echo ${i}`,
    ).join('\n')
    render()
    enqueue(gate(command))
    expect(document.body.textContent).toContain('lines hidden')
    click('Show all')
    expect(document.body.textContent).not.toContain('lines hidden')
  })

  it('leaves an ordinary extension dialog on the generic sheet', () => {
    render()
    enqueue({
      type: 'extension_ui_request',
      id: 'req-2',
      method: 'select',
      title: 'Pick a branch',
      options: ['main', 'dev'],
    })
    expect(document.body.textContent).toContain('Requested by a pi extension')
    expect(document.body.textContent).not.toContain('Run this command?')
  })
})
