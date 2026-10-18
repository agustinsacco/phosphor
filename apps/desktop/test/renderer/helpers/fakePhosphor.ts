import type { IpcInvokeChannel, IpcInvokeMap, PhosphorApi } from '@phosphor/shared/ipc'
import type { RpcCommand, RpcResponse, RpcResponseDataMap } from '@phosphor/shared/rpc'

type InvokeHandler<C extends IpcInvokeChannel> = (
  ...args: IpcInvokeMap[C]['args']
) => IpcInvokeMap[C]['result'] | Promise<IpcInvokeMap[C]['result']>

export type FakePhosphorHandlers = { [C in IpcInvokeChannel]?: InvokeHandler<C> }
export type FakePhosphorOptions = Partial<
  Pick<PhosphorApi, 'platform' | 'pathForFile' | 'spellingSuggestions'>
>

type EventName = Extract<keyof PhosphorApi, `on${string}`>
type Payload<K extends EventName> = Parameters<
  Extract<Parameters<PhosphorApi[K]>[number], (...args: never[]) => void>
>

function createEvent<K extends EventName>() {
  const listeners = new Set<(...args: Payload<K>) => void>()
  return {
    subscribe(listener: (...args: Payload<K>) => void) {
      // Preload creates a unique wrapper even when the callback is reused.
      const wrapped = (...args: Payload<K>) => listener(...args)
      listeners.add(wrapped)
      return () => {
        listeners.delete(wrapped)
      }
    },
    emit(...args: Payload<K>) {
      for (const listener of [...listeners]) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}

function createKeyedEvent<K extends EventName>() {
  const events = new Map<string, ReturnType<typeof createEvent<K>>>()
  return {
    subscribe(key: string, listener: (...args: Payload<K>) => void) {
      let event = events.get(key)
      if (!event) {
        event = createEvent<K>()
        events.set(key, event)
      }
      return event.subscribe(listener)
    },
    emit(key: string, ...args: Payload<K>) {
      events.get(key)?.emit(...args)
    },
    clear() {
      for (const event of events.values()) event.clear()
      events.clear()
    },
  }
}

function createEvents() {
  return {
    onSessionPush: createKeyedEvent<'onSessionPush'>(),
    onSessionsChanged: createEvent<'onSessionsChanged'>(),
    onRoutinesChanged: createEvent<'onRoutinesChanged'>(),
    onPiCommandsChanged: createEvent<'onPiCommandsChanged'>(),
    onFsChanged: createEvent<'onFsChanged'>(),
    onPackagesJobOutput: createKeyedEvent<'onPackagesJobOutput'>(),
    onPackagesJobExit: createKeyedEvent<'onPackagesJobExit'>(),
    onPtyData: createKeyedEvent<'onPtyData'>(),
    onPtyExit: createKeyedEvent<'onPtyExit'>(),
    onPtyStatus: createEvent<'onPtyStatus'>(),
    onUpdateEvent: createEvent<'onUpdateEvent'>(),
    onMcpAuthState: createEvent<'onMcpAuthState'>(),
    onPiLoginState: createEvent<'onPiLoginState'>(),
    onClaudeLoginState: createEvent<'onClaudeLoginState'>(),
    onAccountChanged: createEvent<'onAccountChanged'>(),
    onMachinesChanged: createEvent<'onMachinesChanged'>(),
    onHostsChanged: createEvent<'onHostsChanged'>(),
    onHostAttention: createEvent<'onHostAttention'>(),
    onHostOpenLane: createEvent<'onHostOpenLane'>(),
    onVoiceStatus: createEvent<'onVoiceStatus'>(),
  }
}

function createInvoke(handlers: FakePhosphorHandlers): PhosphorApi['invoke'] {
  return async <C extends IpcInvokeChannel>(channel: C, ...args: IpcInvokeMap[C]['args']) => {
    if (!Object.hasOwn(handlers, channel) || !handlers[channel]) {
      throw new Error(`Unconfigured fakePhosphor invocation: ${channel}`)
    }
    // Indexing a mapped handler table loses the channel/argument correlation in TS.
    const handler = handlers[channel] as InvokeHandler<C>
    return await handler(...args)
  }
}

function createApi(
  events: ReturnType<typeof createEvents>,
  handlers: FakePhosphorHandlers,
  options: FakePhosphorOptions,
): PhosphorApi {
  const invoke = createInvoke(handlers)
  return {
    platform: options.platform ?? 'linux',
    invoke,
    onSessionPush: events.onSessionPush.subscribe,
    onSessionsChanged: events.onSessionsChanged.subscribe,
    onRoutinesChanged: events.onRoutinesChanged.subscribe,
    onPiCommandsChanged: events.onPiCommandsChanged.subscribe,
    onFsChanged: events.onFsChanged.subscribe,
    onPackagesJobOutput: events.onPackagesJobOutput.subscribe,
    onPackagesJobExit: events.onPackagesJobExit.subscribe,
    onPtyData: events.onPtyData.subscribe,
    onPtyExit: events.onPtyExit.subscribe,
    onPtyStatus: events.onPtyStatus.subscribe,
    onUpdateEvent: events.onUpdateEvent.subscribe,
    onMcpAuthState: events.onMcpAuthState.subscribe,
    onPiLoginState: events.onPiLoginState.subscribe,
    onClaudeLoginState: events.onClaudeLoginState.subscribe,
    onAccountChanged: events.onAccountChanged.subscribe,
    onMachinesChanged: events.onMachinesChanged.subscribe,
    onHostsChanged: events.onHostsChanged.subscribe,
    onHostAttention: events.onHostAttention.subscribe,
    onHostOpenLane: events.onHostOpenLane.subscribe,
    onVoiceStatus: events.onVoiceStatus.subscribe,
    pathForFile: options.pathForFile ?? (() => ''),
    spellingSuggestions: options.spellingSuggestions ?? (() => null),
    piCommand<T extends RpcCommand['type']>(
      sessionId: string,
      command: Extract<RpcCommand, { type: T }>,
    ) {
      // The convenience method refines the same unparameterized IPC response as preload.
      return invoke('pi:command', sessionId, command) as Promise<RpcResponse<RpcResponseDataMap[T]>>
    },
  }
}

/** No global changes: install explicitly and restore in afterEach. */
export function createFakePhosphor(
  handlers: FakePhosphorHandlers = {},
  options: FakePhosphorOptions = {},
) {
  const events = createEvents()
  return {
    api: createApi(events, handlers, options),
    events,
    dispose() {
      for (const event of Object.values(events)) event.clear()
    },
  }
}

/** Nested installations must be restored in reverse order, like a descriptor stack. */
export function installFakePhosphor(fake: ReturnType<typeof createFakePhosphor>): () => void {
  const previous = Object.getOwnPropertyDescriptor(window, 'phosphor')
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: fake.api,
  })
  let restored = false
  return () => {
    if (restored) return
    if (previous) Object.defineProperty(window, 'phosphor', previous)
    else Reflect.deleteProperty(window, 'phosphor')
    restored = true
  }
}
