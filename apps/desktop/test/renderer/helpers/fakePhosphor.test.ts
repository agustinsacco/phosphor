// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakePhosphor, installFakePhosphor } from './fakePhosphor'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

describe('createFakePhosphor', () => {
  it('provides the complete preload surface without installing it', () => {
    const before = Object.getOwnPropertyDescriptor(window, 'phosphor')
    const fake = createFakePhosphor()
    expect(Object.getOwnPropertyDescriptor(window, 'phosphor')).toEqual(before)
    expect(Object.keys(fake.api).sort()).toEqual(
      [
        'platform',
        'invoke',
        'piCommand',
        'pathForFile',
        'spellingSuggestions',
        'onSessionPush',
        'onSessionsChanged',
        'onRoutinesChanged',
        'onPiCommandsChanged',
        'onFsChanged',
        'onPackagesJobOutput',
        'onPackagesJobExit',
        'onPtyData',
        'onPtyExit',
        'onPtyStatus',
        'onUpdateEvent',
        'onMcpAuthState',
        'onPiLoginState',
        'onClaudeLoginState',
        'onAccountChanged',
        'onMachinesChanged',
        'onHostsChanged',
        'onHostAttention',
        'onHostOpenLane',
        'onVoiceStatus',
      ].sort(),
    )
    expect(fake.api.platform).toBe('linux')
    expect(fake.api.pathForFile(new File([], 'file.txt'))).toBe('')
    expect(fake.api.spellingSuggestions('word')).toBeNull()
  })

  it('accepts synchronous and asynchronous channel handlers and forwards arguments', async () => {
    const authorize = vi.fn(async (server: string, workspacePath?: string) => {
      expect([server, workspacePath]).toEqual(['linear', '/workspace'])
    })
    const fake = createFakePhosphor({
      'mcp:authorize': authorize,
      'pi:commands': (workspacePath) => ({
        commands: [],
        error: workspacePath,
      }),
    })
    await expect(fake.api.invoke('mcp:authorize', 'linear', '/workspace')).resolves.toBeUndefined()
    await expect(fake.api.invoke('pi:commands', '/workspace')).resolves.toEqual({
      commands: [],
      error: '/workspace',
    })
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('rejects unconfigured and unknown invocations with the channel name', async () => {
    const fake = createFakePhosphor()
    await expect(fake.api.invoke('pi:commands')).rejects.toThrow('pi:commands')
    await expect(Reflect.apply(fake.api.invoke, undefined, ['unknown:channel'])).rejects.toThrow(
      'unknown:channel',
    )
    await expect(Reflect.apply(fake.api.invoke, undefined, ['toString'])).rejects.toThrow(
      'toString',
    )
  })

  it('turns synchronous throws into rejections and preserves async rejections', async () => {
    const failure = new Error('handler failed')
    const fake = createFakePhosphor({
      'pi:commands': () => {
        throw failure
      },
      'mcp:authorize': async () => {
        throw failure
      },
    })
    await expect(fake.api.invoke('pi:commands')).rejects.toBe(failure)
    await expect(fake.api.invoke('mcp:authorize', 'linear')).rejects.toBe(failure)
  })

  it('forwards piCommand through the pi:command handler', async () => {
    const response = {
      type: 'response' as const,
      command: 'get_commands',
      success: true as const,
      data: { commands: [] },
    }
    const handler = vi.fn(() => response)
    const fake = createFakePhosphor({ 'pi:command': handler })
    await expect(fake.api.piCommand('session', { type: 'get_commands' })).resolves.toBe(response)
    expect(handler).toHaveBeenCalledWith('session', { type: 'get_commands' })
    await expect(createFakePhosphor().api.piCommand('s', { type: 'get_state' })).rejects.toThrow(
      'pi:command',
    )
  })

  it('keeps factories and keyed listeners independent and supports unsubscribe', () => {
    const first = createFakePhosphor()
    const second = createFakePhosphor()
    const listener = vi.fn()
    const other = vi.fn()
    const unsubscribe = first.api.onPtyData('pty', listener)
    first.api.onPtyData('other', other)
    second.api.onPtyData('pty', other)
    first.events.onPtyData.emit('pty', 'hello')
    expect(listener).toHaveBeenCalledExactlyOnceWith('hello')
    expect(other).not.toHaveBeenCalled()
    unsubscribe()
    unsubscribe()
    first.events.onPtyData.emit('pty', 'ignored')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('treats repeated callbacks as separate subscriptions', () => {
    const fake = createFakePhosphor()
    const listener = vi.fn()
    const unsubscribe = fake.api.onHostsChanged(listener)
    fake.api.onHostsChanged(listener)
    fake.events.onHostsChanged.emit()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    fake.events.onHostsChanged.emit()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('delivers typed payloads and clears all listener sets on dispose', () => {
    const fake = createFakePhosphor()
    const fs = vi.fn()
    const routine = vi.fn()
    const session = vi.fn()
    fake.api.onFsChanged(fs)
    fake.api.onRoutinesChanged(routine)
    fake.api.onSessionPush('session', session)
    const payload = { workspacePath: '/workspace', paths: ['a.ts'] }
    fake.events.onFsChanged.emit(payload)
    fake.events.onRoutinesChanged.emit({ machine: 'host' })
    fake.events.onRoutinesChanged.emit()
    expect(fs).toHaveBeenCalledExactlyOnceWith(payload)
    expect(routine.mock.calls).toEqual([[{ machine: 'host' }], []])
    fake.dispose()
    fake.dispose()
    fake.events.onFsChanged.emit(payload)
    fake.events.onRoutinesChanged.emit()
    fake.events.onSessionPush.emit('session', { kind: 'resync' })
    expect(fs).toHaveBeenCalledOnce()
    expect(routine).toHaveBeenCalledTimes(2)
    expect(session).not.toHaveBeenCalled()
  })

  it('supports explicit synchronous preload overrides', () => {
    const fake = createFakePhosphor(
      {},
      {
        platform: 'darwin',
        pathForFile: (file) => `/picked/${file.name}`,
        spellingSuggestions: () => ['fixed'],
      },
    )
    expect(fake.api.platform).toBe('darwin')
    expect(fake.api.pathForFile(new File([], 'a.txt'))).toBe('/picked/a.txt')
    expect(fake.api.spellingSuggestions('typo')).toEqual(['fixed'])
  })
})

describe('installFakePhosphor', () => {
  it('preserves window identity and restores an absent property', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'phosphor')
    cleanups.push(() => {
      if (original) Object.defineProperty(window, 'phosphor', original)
      else Reflect.deleteProperty(window, 'phosphor')
    })
    Reflect.deleteProperty(window, 'phosphor')
    const originalWindow = window
    const fake = createFakePhosphor()
    const restore = installFakePhosphor(fake)
    cleanups.push(restore)
    expect(window).toBe(originalWindow)
    expect(window.phosphor).toBe(fake.api)
    restore()
    restore()
    expect(Object.hasOwn(window, 'phosphor')).toBe(false)
  })

  it('restores the exact descriptor and supports nested installations in reverse order', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'phosphor')
    cleanups.push(() => {
      if (original) Object.defineProperty(window, 'phosphor', original)
      else Reflect.deleteProperty(window, 'phosphor')
    })
    const previous = createFakePhosphor().api
    const descriptor = { configurable: true, enumerable: false, get: () => previous }
    Object.defineProperty(window, 'phosphor', descriptor)
    const first = createFakePhosphor()
    const restoreFirst = installFakePhosphor(first)
    cleanups.push(restoreFirst)
    const second = createFakePhosphor()
    const restoreSecond = installFakePhosphor(second)
    cleanups.push(restoreSecond)
    expect(window.phosphor).toBe(second.api)
    restoreSecond()
    expect(window.phosphor).toBe(first.api)
    restoreFirst()
    expect(Object.getOwnPropertyDescriptor(window, 'phosphor')).toEqual(descriptor)
  })
})
