// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useConnectorsStore } from '@/stores/connectors'
import { ConnectorsTab } from './ConnectorsTab'

vi.mock('../SettingsMachineScope', () => ({ useSettingsWorkspace: () => '/workspace' }))
vi.mock('@/features/files/MonacoEditor', () => ({ MonacoEditor: () => null }))

const invoke = vi.fn(async (channel: string) => {
  switch (channel) {
    case 'mcp:readConfigs':
      return { servers: [], files: [], errors: [] }
    case 'packages:list':
      return []
    case 'mcp:upsertServer':
    case 'mcp:authorize':
      return undefined
    default:
      throw new Error(`Unexpected IPC channel: ${channel}`)
  }
})

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(async () => {
  invoke.mockClear()
  vi.stubGlobal('phosphor', { invoke })
  useConnectorsStore.setState({ flows: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<ConnectorsTab />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function row(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid="connector-${id}"]`)!
}

function input(connector: HTMLElement, placeholder: string): HTMLInputElement {
  return connector.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
}

function type(field: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const connectors = [
  { id: 'slack', placeholder: 'client secret (optional)', required: false },
  { id: 'google-drive', placeholder: 'client secret', required: true },
]

describe('ConnectorsTab client secrets', () => {
  it.each(connectors)(
    'masks the $id secret but leaves the client ID as text',
    ({ id, placeholder }) => {
      const connector = row(id)
      expect(input(connector, 'client ID').type).toBe('text')
      expect(input(connector, placeholder).type).toBe('password')
    },
  )

  it.each(connectors)(
    'keeps the typed $id secret in its intended saved OAuth config, not visible text',
    async ({ id, placeholder, required }) => {
      const connector = row(id)
      const add = connector.querySelector<HTMLButtonElement>('button')!
      expect(add.disabled).toBe(true)
      type(input(connector, 'client ID'), 'registered-client-id')
      expect(add.disabled).toBe(required)
      const secret = 'private-client-secret'
      const secretInput = input(connector, placeholder)
      type(secretInput, secret)
      expect(secretInput.value).toBe(secret)
      expect(connector.textContent).not.toContain(secret)
      expect(
        [...connector.querySelectorAll('input')].filter(
          (field) => field.type === 'text' && field.value === secret,
        ),
      ).toEqual([])
      expect(add.disabled).toBe(false)

      await act(async () => add.click())

      expect(invoke).toHaveBeenCalledWith(
        'mcp:upsertServer',
        'global',
        undefined,
        id,
        expect.objectContaining({
          oauth: expect.objectContaining({
            clientId: 'registered-client-id',
            clientSecret: secret,
            callbackUrl: 'http://localhost:19876/callback',
          }),
        }),
      )
      expect(invoke).toHaveBeenCalledWith('mcp:authorize', id, '/workspace')
      expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
        'mcp:readConfigs',
        'packages:list',
        'mcp:upsertServer',
        'mcp:authorize',
        'mcp:readConfigs',
        'packages:list',
      ])
    },
  )

  it('still allows the optional Slack secret to be omitted', async () => {
    const connector = row('slack')
    type(input(connector, 'client ID'), 'public-client-id')
    await act(async () => connector.querySelector<HTMLButtonElement>('button')!.click())
    expect(invoke).toHaveBeenCalledWith(
      'mcp:upsertServer',
      'global',
      undefined,
      'slack',
      expect.objectContaining({
        oauth: expect.not.objectContaining({ clientSecret: expect.anything() }),
      }),
    )
  })
})
