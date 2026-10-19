// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@shared/mcp'
import { AddHostConnector } from './AddHostConnector'

let root: Root, container: HTMLDivElement
const save = vi.fn<(name: string, config: McpServerConfig) => Promise<void>>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  save.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root.render(<AddHostConnector label="bee" busy={false} onClose={() => {}} onSave={save} />),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function change(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!
  const prototype =
    input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    )
  })
}
async function submit() {
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent === 'Review and add',
  )!
  await act(async () => button.click())
}
it('validates custom Host URLs and never embeds credentials in them', async () => {
  change('Connector catalogue', 'custom')
  change('Server name', 'custom-server')
  change('Server URL', 'http://remote.example/mcp')
  await submit()
  expect(document.body.textContent).toContain(
    'Use HTTPS, or an HTTP loopback server running on the Host.',
  )
  expect(save).not.toHaveBeenCalled()
  change('Server URL', 'https://user:password@example.com/mcp')
  await submit()
  expect(document.body.textContent).toContain('Do not embed credentials in the URL.')
  change('Server URL', 'http://127.0.0.1:8080/mcp')
  change('Authorization header', 'Bearer host-secret')
  await submit()
  expect(save).toHaveBeenCalledWith('custom-server', {
    url: 'http://127.0.0.1:8080/mcp',
    headers: { Authorization: 'Bearer host-secret' },
  })
})
it('keeps custom command arguments separate and reports unconfirmed saves', async () => {
  change('Connector catalogue', 'custom')
  change('Server name', 'host-command')
  change('Connector transport', 'stdio')
  change('Host command', 'npx')
  change('Host command arguments', '-y\n@vendor/mcp-server\n')
  save.mockRejectedValueOnce(new Error('Host save not confirmed'))
  await submit()
  expect(save).toHaveBeenCalledWith('host-command', {
    command: 'npx',
    args: ['-y', '@vendor/mcp-server'],
  })
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Host save not confirmed')
})
it('resets one-time custom secrets when switching catalogue entries', async () => {
  change('Connector catalogue', 'custom')
  change('Server name', 'custom-server')
  change('Server URL', 'https://example.com/mcp')
  change('Authorization header', 'Bearer old-secret')
  change('Connector catalogue', 'slack')
  expect(document.querySelector('[aria-label="Client ID"]')).not.toBeNull()
  change('Connector catalogue', 'custom')
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="Authorization header"]')!.value,
  ).toBe('')
  await submit()
  expect(save).toHaveBeenCalledWith('custom-server', { url: 'https://example.com/mcp' })
})
