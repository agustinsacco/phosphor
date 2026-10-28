import type { PhosphorApi, IpcInvokeChannel, IpcInvokeMap } from '@phosphor/shared/ipc'
import { IPC_WEB, type WebSupportedChannel } from '@phosphor/shared/ipc-web'
import { createRemoteLanes } from '@phosphor/host-client/remote-lanes'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import type { IdentityCrypto } from '@phosphor/host-client/crypto'
import { createBrowserControl } from './control'
import { createBrowserHosts, DIRECTORY_POLL_MS } from './hosts'
import { createBrowserEvents } from './events'
import { createBrowserPreferences, type PreferenceStorage } from './preferences'
import { createBrowserResources } from './resources'
import { createBrowserHandlers } from './handlers'
import { createBrowserTerminals } from './terminals'
import { createBrowserSettings } from './settings'
import { captureCompletionFence } from './completion-fence'
import { createBrowserDrafts, OWNER_DRAFT_CHANNELS } from './drafts'

/** Lifecycle and invalidation ports contain no account or lane data. */
export interface BrowserLifecycle {
  subscribe(resume: () => void): () => void
}
export interface BrowserInvalidation {
  subscribe(invalidate: () => void): () => void
  publish(): void
  close(): void
}
export interface BrowserApiOptions {
  fetch?: typeof fetch
  navigate?: (path: string) => void
  openExternal?: (url: string) => void
  storage?: PreferenceStorage | null
  lifecycle?: BrowserLifecycle
  invalidation?: BrowserInvalidation | null
  socket?: (url: string) => Promise<FrameSocket>
  identity?: IdentityCrypto
  platform?: PhosphorApi['platform']
}
function browserLifecycle(): BrowserLifecycle {
  return {
    subscribe(resume) {
      const visible = () => {
        if (document.visibilityState === 'visible') resume()
      }
      document.addEventListener('visibilitychange', visible)
      window.addEventListener('pageshow', resume)
      window.addEventListener('online', resume)
      return () => {
        document.removeEventListener('visibilitychange', visible)
        window.removeEventListener('pageshow', resume)
        window.removeEventListener('online', resume)
      }
    },
  }
}
function browserInvalidation(): BrowserInvalidation | null {
  if (typeof BroadcastChannel === 'undefined') return null
  const channel = new BroadcastChannel('phosphor.web.invalidation.v1')
  return {
    subscribe(invalidate) {
      const listener = (event: MessageEvent) => {
        if (event.data === 'invalidate') invalidate()
      }
      channel.addEventListener('message', listener)
      return () => channel.removeEventListener('message', listener)
    },
    publish: () => channel.postMessage('invalidate'),
    close: () => channel.close(),
  }
}
function browserStorage(): PreferenceStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** A failed `pi:command` answers as pi would, so the chat shows it. */
function piFailure(args: unknown[], error: string) {
  const command = args[1] as IpcInvokeMap['pi:command']['args'][1]
  return { type: 'response', command: command.type, id: command.id, success: false, error }
}
/** Install api on window BEFORE importing the shared UI; call start after installation. */
export function createBrowserApi(options: BrowserApiOptions = {}): {
  api: PhosphorApi
  start(): Promise<void>
  dispose(): void
} {
  const events = createBrowserEvents()
  const prefs = createBrowserPreferences(
    options.storage === null ? undefined : (options.storage ?? browserStorage()),
  )
  const invalidation =
    options.invalidation === undefined ? browserInvalidation() : options.invalidation
  let stopped = false,
    started = false,
    refreshing: Promise<void> | undefined
  let poll: ReturnType<typeof setInterval> | undefined,
    clock: ReturnType<typeof setInterval> | undefined
  let offLifecycle = () => {},
    offInvalidation = () => {}
  const control = createBrowserControl({
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    navigate: options.navigate ?? ((path) => location.assign(path)),
    changed: (view) => {
      events.emit('account', view)
      events.emit('machines', undefined)
    },
    invalidate: () => {
      terminals.clear()
      lanes.clear()
      hosts.clear()
      resources.clear()
      prefs.clearOwner()
      drafts.clearOwner()
      events.clearSessions()
    },
  })
  const drafts = createBrowserDrafts(() => control.session() !== null)
  const hosts = createBrowserHosts({
    control,
    socket: options.socket,
    identity: options.identity,
    changed: () => {
      lanes.reconcile()
      terminals.reconcile()
      events.emit('hosts', undefined)
    },
    routinesChanged: (hostId) => events.emit('routines', { machine: `host:${hostId}` }),
    attention: (hostId, event) =>
      events.emit('attention', {
        hostId,
        laneId: event.laneId,
        title: event.title ?? 'Untitled lane',
        at: event.at,
        kind: event.kind.startsWith('routine-') ? 'routine' : event.kind,
      }),
  })
  const lanes = createRemoteLanes({
    identity: options.identity,
    connection: hosts.connection,
    present: hosts.present,
    label: hosts.label,
    changed: () => events.emit('hosts', undefined),
  })
  const resources = createBrowserResources(hosts, lanes)
  const terminals = createBrowserTerminals({ hosts, lanes, control, events })
  const handlers = createBrowserHandlers({
    control,
    hosts,
    lanes,
    resources,
    terminals: terminals.handlers,
    settings: createBrowserSettings({ control, hosts }),
    prefs,
    drafts,
    window: () => {
      const epoch = control.generation()
      return {
        id: 1,
        destroyed: () => stopped || epoch !== control.generation(),
        send: (channel, push) => {
          if (!stopped && epoch === control.generation()) events.emit(channel, push)
        },
      }
    },
    openExternal:
      options.openExternal ??
      ((url) => {
        // noopener intentionally withholds a handle even when navigation succeeds.
        window.open(url, '_blank', 'noopener,noreferrer')
      }),
    broadcastLogout: () => invalidation?.publish(),
    machinesChanged: () => events.emit('machines', undefined),
  })
  async function invoke<C extends IpcInvokeChannel>(
    channel: C,
    ...args: IpcInvokeMap[C]['args']
  ): Promise<IpcInvokeMap[C]['result']> {
    if (stopped) throw new Error('Browser adapter disposed.')
    const classification = Object.hasOwn(IPC_WEB, channel) ? IPC_WEB[channel] : undefined
    if (!classification || classification.kind === 'unsupported')
      throw new Error(classification?.reason ?? 'Unknown browser IPC channel.')
    const epoch = control.generation(),
      transportCurrent = captureCompletionFence(channel, args, hosts.snapshot, lanes.list(1))
    // This single dispatch cast bridges TypeScript's generic indexed tuple intersection.
    const handler = handlers[channel as WebSupportedChannel] as (
      ...args: IpcInvokeMap[C]['args']
    ) => IpcInvokeMap[C]['result'] | Promise<IpcInvokeMap[C]['result']>
    let result: IpcInvokeMap[C]['result']
    try {
      result = await handler(...args)
    } catch (error) {
      if (channel !== 'pi:command') throw error
      return piFailure(args, 'Remote lane unavailable.') as IpcInvokeMap[C]['result']
    }
    if (OWNER_DRAFT_CHANNELS.has(channel) && (stopped || epoch !== control.generation()))
      throw new Error('Draft owner changed.')
    if (channel.startsWith('control:') && (stopped || epoch !== control.generation())) {
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false)
        return result
      return {
        ok: false,
        error: { code: 'signed-out', message: 'Account changed.' },
      } as IpcInvokeMap[C]['result']
    }
    const remote =
      classification.kind === 'remote-supported' &&
      !channel.startsWith('account:') &&
      !channel.startsWith('control:') &&
      // Both replace the Host connection on purpose: the new one is the result.
      channel !== 'hosts:reconnect' &&
      channel !== 'hosts:settingsAccess'
    if (remote && (stopped || epoch !== control.generation() || !transportCurrent())) {
      if (channel === 'pi:command')
        return piFailure(
          args,
          'Remote connection changed. Refresh before retrying.',
        ) as IpcInvokeMap[C]['result']
      throw new Error('Remote connection changed. Refresh before retrying.')
    }
    return result
  }
  const api: PhosphorApi = {
    platform:
      options.platform ??
      (/Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')
        ? 'darwin'
        : /Win/.test(globalThis.navigator?.platform ?? '')
          ? 'win32'
          : 'linux'),
    invoke,
    piCommand: ((id, command) => invoke('pi:command', id, command)) as PhosphorApi['piCommand'],
    onSessionPush: (id, listener) => events.on(`pi:event:${id}`, listener),
    onAccountChanged: (listener) => events.on('account', listener),
    onMachinesChanged: (listener) => events.on('machines', listener),
    onHostsChanged: (listener) => events.on('hosts', listener),
    onHostAttention: (listener) => events.on('attention', listener),
    onRoutinesChanged: (listener) => events.on('routines', listener),
    onHostOpenLane: (listener) => events.on('openLane', listener),
    onPiCommandsChanged: (listener) => events.on('commands', listener),
    onSessionsChanged: (listener) => events.on('sessions', listener),
    onFsChanged: (listener) => events.on('files', listener),
    onPackagesJobOutput: (id, listener) => events.on(`package-output:${id}`, listener),
    onPackagesJobExit: (id, listener) => events.on(`package-exit:${id}`, listener),
    onPtyData: (id, listener) => events.on(`pty-data:${id}`, listener),
    onPtyExit: (id, listener) => events.on(`pty-exit:${id}`, listener),
    onPtyStatus: (listener) => events.on('pty-status', listener),
    onUpdateEvent: (listener) => events.on('updates', listener),
    onMcpAuthState: (listener) => events.on('mcp', listener),
    onPiLoginState: (listener) => events.on('pi-login', listener),
    onClaudeLoginState: (listener) => events.on('claude-login', listener),
    onVoiceStatus: (listener) => events.on('voice', listener),
    pathForFile: () => '',
    spellingSuggestions: () => null,
  }
  const refreshQuietly = () => void refresh().catch(() => {})
  function refresh() {
    if (stopped) return Promise.resolve()
    return (refreshing ??= (async () => {
      await control.refresh()
      if (!stopped) await hosts.refresh()
    })().finally(() => {
      refreshing = undefined
    }))
  }
  return {
    api,
    async start() {
      if (stopped) throw new Error('Browser adapter disposed.')
      if (!started) {
        started = true
        offLifecycle = (options.lifecycle ?? browserLifecycle()).subscribe(() => {
          hosts.wake()
          refreshQuietly()
        })
        offInvalidation = invalidation?.subscribe(control.invalidate) ?? (() => {})
        poll = setInterval(refreshQuietly, DIRECTORY_POLL_MS)
        clock = setInterval(hosts.reconcile, 5000)
      }
      await refresh()
    },
    dispose() {
      if (stopped) return
      stopped = true
      clearInterval(poll)
      clearInterval(clock)
      offLifecycle()
      offInvalidation()
      invalidation?.close()
      control.dispose()
      terminals.clear()
      hosts.dispose()
      lanes.clear()
      resources.clear()
      events.clear()
    },
  }
}
