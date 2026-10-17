import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { PhosphorApi } from '@shared/ipc'

const electron = vi.hoisted(() => ({
  contextBridge: {
    exposeInMainWorld: vi.fn<(key: string, api: PhosphorApi) => void>(),
  },
  ipcRenderer: {
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    on: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
    removeListener: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
  },
  webFrame: {
    isWordMisspelled: vi.fn(),
    getWordSuggestions: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}))
const appearance = vi.hoisted(() => ({ applyStartupAppearance: vi.fn() }))

vi.mock('electron', () => electron)
vi.mock('../../electron/startup-appearance', () => appearance)

let api: PhosphorApi
beforeAll(async () => {
  await import('../../electron/preload')
  const exposure = electron.contextBridge.exposeInMainWorld.mock.calls[0]
  if (!exposure) throw new Error('Preload did not expose its API')
  api = exposure[1]
})

beforeEach(() => {
  electron.ipcRenderer.invoke.mockReset()
  electron.ipcRenderer.on.mockClear()
  electron.ipcRenderer.removeListener.mockClear()
})

it('exposes only the reviewed phosphor API keys through the original preload', () => {
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledExactlyOnceWith('phosphor', api)
  expect(appearance.applyStartupAppearance).toHaveBeenCalledExactlyOnceWith(process.argv)
  expect(Object.keys(api).sort()).toEqual([
    'invoke',
    'onAccountChanged',
    'onClaudeLoginState',
    'onFsChanged',
    'onHostAttention',
    'onHostOpenLane',
    'onHostsChanged',
    'onMachinesChanged',
    'onMcpAuthState',
    'onPackagesJobExit',
    'onPackagesJobOutput',
    'onPiCommandsChanged',
    'onPiLoginState',
    'onPtyData',
    'onPtyExit',
    'onPtyStatus',
    'onRoutinesChanged',
    'onSessionPush',
    'onSessionsChanged',
    'onUpdateEvent',
    'onVoiceStatus',
    'pathForFile',
    'piCommand',
    'platform',
    'spellingSuggestions',
  ])
})

it('forwards invoke channels, positional arguments and the original response promise', async () => {
  const response = Promise.resolve({ commands: [] })
  electron.ipcRenderer.invoke.mockReturnValue(response)
  const result = api.invoke('pi:commands', '/workspace')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('pi:commands', '/workspace')
  expect(result).toBe(response)
  await expect(result).resolves.toEqual({ commands: [] })

  electron.ipcRenderer.invoke.mockClear()
  api.invoke('app:getPrefs')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('app:getPrefs')
})

it('forwards piCommand session and command without changing the RPC envelope', async () => {
  const command = { type: 'prompt', message: 'hello' } as const
  const envelope = { type: 'response', command: 'prompt', success: true }
  const response = Promise.resolve(envelope)
  electron.ipcRenderer.invoke.mockReturnValue(response)
  const result = api.piCommand('session-1', command)
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(
    'pi:command',
    'session-1',
    command,
  )
  expect(electron.ipcRenderer.invoke.mock.calls[0]?.[2]).toBe(command)
  expect(result).toBe(response)
  await expect(result).resolves.toBe(envelope)
})

it('preserves rejected invoke and piCommand promises for callers', async () => {
  const error = new Error('IPC failed')
  electron.ipcRenderer.invoke.mockRejectedValue(error)
  await expect(api.invoke('pi:health')).rejects.toBe(error)
  await expect(api.piCommand('session-1', { type: 'get_state' })).rejects.toBe(error)
})

type Subscribe = (api: PhosphorApi, listener: (...args: unknown[]) => void) => () => void
const subscriptions: ReadonlyArray<readonly [string, string, Subscribe]> = [
  [
    'onSessionPush',
    'pi:event:session-1',
    (api, listener) => api.onSessionPush('session-1', listener),
  ],
  ['onRoutinesChanged', 'routines:changed', (api, listener) => api.onRoutinesChanged(listener)],
  ['onSessionsChanged', 'sessions:changed', (api, listener) => api.onSessionsChanged(listener)],
  [
    'onPiCommandsChanged',
    'pi:commandsChanged',
    (api, listener) => api.onPiCommandsChanged(listener),
  ],
  ['onFsChanged', 'fs:changed', (api, listener) => api.onFsChanged(listener)],
  [
    'onPackagesJobOutput',
    'packages:output:job-1',
    (api, listener) => api.onPackagesJobOutput('job-1', listener),
  ],
  [
    'onPackagesJobExit',
    'packages:exit:job-1',
    (api, listener) => api.onPackagesJobExit('job-1', listener),
  ],
  ['onPtyData', 'pty:data:pty-1', (api, listener) => api.onPtyData('pty-1', listener)],
  ['onPtyExit', 'pty:exit:pty-1', (api, listener) => api.onPtyExit('pty-1', listener)],
  ['onUpdateEvent', 'updates:event', (api, listener) => api.onUpdateEvent(listener)],
  ['onMcpAuthState', 'mcp:authState', (api, listener) => api.onMcpAuthState(listener)],
  ['onPiLoginState', 'pi:loginState', (api, listener) => api.onPiLoginState(listener)],
  ['onClaudeLoginState', 'claude:loginState', (api, listener) => api.onClaudeLoginState(listener)],
  ['onAccountChanged', 'account:changed', (api, listener) => api.onAccountChanged(listener)],
  ['onHostsChanged', 'hosts:changed', (api, listener) => api.onHostsChanged(listener)],
  ['onHostAttention', 'hosts:attention', (api, listener) => api.onHostAttention(listener)],
  ['onHostOpenLane', 'hosts:openLaneRequested', (api, listener) => api.onHostOpenLane(listener)],
  [
    'onMachinesChanged',
    'control:machinesChanged',
    (api, listener) => api.onMachinesChanged(listener),
  ],
  ['onVoiceStatus', 'voice:statusChanged', (api, listener) => api.onVoiceStatus(listener)],
  ['onPtyStatus', 'pty:status', (api, listener) => api.onPtyStatus(listener)],
]

it.each(subscriptions)(
  '%s pins its channel, drops the Electron event and unsubscribes its own wrapper',
  (_name, channel, subscribe) => {
    const listener = vi.fn()
    const unsubscribeFirst = subscribe(api, listener)
    const unsubscribeSecond = subscribe(api, listener)
    expect(electron.ipcRenderer.on).toHaveBeenCalledTimes(2)
    const first = electron.ipcRenderer.on.mock.calls[0]
    const second = electron.ipcRenderer.on.mock.calls[1]
    if (!first || !second) throw new Error('Missing subscription wrappers')
    expect(first[0]).toBe(channel)
    expect(second[0]).toBe(channel)
    expect(first[1]).not.toBe(listener)
    expect(second[1]).not.toBe(first[1])
    expect(electron.ipcRenderer.removeListener).not.toHaveBeenCalled()

    const event = { sender: 'Electron-only event' }
    const payload = { value: 'push payload' }
    first[1](event, payload, 'extra argument')
    expect(listener).toHaveBeenCalledExactlyOnceWith(payload, 'extra argument')
    expect(listener.mock.calls[0]?.[0]).toBe(payload)
    listener.mockClear()
    second[1](event)
    expect(listener).toHaveBeenCalledExactlyOnceWith()

    unsubscribeSecond()
    expect(electron.ipcRenderer.removeListener).toHaveBeenNthCalledWith(1, channel, second[1])
    unsubscribeFirst()
    expect(electron.ipcRenderer.removeListener).toHaveBeenNthCalledWith(2, channel, first[1])
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(2)
  },
)
