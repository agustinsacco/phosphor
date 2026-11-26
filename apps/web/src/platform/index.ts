import { createBrowserAttention } from './attention'
import { attachNotificationClicks, navigateNotification } from './notifications'
import type { PhosphorApi, IpcInvokeChannel, IpcInvokeMap } from '@phosphor/shared/ipc'
import { IPC_WEB, type WebSupportedChannel } from '@phosphor/shared/ipc-web'
import { createRemoteLanes, type RemoteWindow } from '@phosphor/host-client/remote-lanes'
import { createHostLaneMoves } from '@phosphor/host-client/lane-move'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import type { IdentityCrypto } from '@phosphor/host-client/crypto'
import { createBrowserControl, type BrowserControl } from './control'
import { createBrowserHosts, DIRECTORY_POLL_MS, type BrowserHosts } from './hosts'
import { createBrowserEvents } from './events'
import { createBrowserPreferences, type PreferenceStorage } from './preferences'
import { createBrowserResources } from './resources'
import { createBrowserHandlers } from './handlers'
import { createBrowserTerminals } from './terminals'
import { createBrowserSettings } from './settings'
import { captureCompletionFence } from './completion-fence'
import { createBrowserDrafts, OWNER_DRAFT_CHANNELS } from './drafts'
import { createBrowserFileBytes } from './file-bytes'
import { createBrowserPush } from './push'

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
  /** Full-page navigation for account sign-in. */
  navigate?: (path: string) => void
  /** In-app history navigation for a native notification click. */
  navigateNotification?: (path: string) => void
  /** Reloads the page once a different owner signs in while it is open. */
  reload?: () => void
  openExternal?: (url: string) => void
  storage?: PreferenceStorage | null
  lifecycle?: BrowserLifecycle
  invalidation?: BrowserInvalidation | null
  socket?: (url: string) => Promise<FrameSocket>
  identity?: IdentityCrypto
  platform?: PhosphorApi['platform']
  /** A failed sign-in's message from the address (`takeSignInError`). */
  signInError?: string
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

/** The prefs over the page's storage; the page reloads when another owner signs in on it. */
const browserPreferences = (options: BrowserApiOptions) =>
  createBrowserPreferences(
    options.storage === null ? undefined : (options.storage ?? browserStorage()),
    options.reload ?? (() => location.reload()),
  )

/** A failed `pi:command` answers as pi would, so the chat shows it. */
function piFailure(args: unknown[], error: string) {
  const command = args[1] as IpcInvokeMap['pi:command']['args'][1]
  return { type: 'response', command: command.type, id: command.id, success: false, error }
}
/**
 * "Move to…" between Hosts with this browser's branch prefix. A move's bundle lives only in the
 * page's memory; invalidation (an owner change, sign-out, dispose) aborts it.
 */
const browserLaneMoves = (hosts: BrowserHosts, prefs: ReturnType<typeof browserPreferences>) =>
  createHostLaneMoves({
    connection: hosts.connection,
    label: hosts.label,
    branchPrefix: async () => (await prefs.read()).worktrees.branchPrefix,
  })
/** The tab is window 1; it is gone once the page is disposed or its account changes. */
function tabWindow(
  control: BrowserControl,
  events: ReturnType<typeof createBrowserEvents>,
  stopped: () => boolean,
): RemoteWindow {
  const epoch = control.generation()
  const current = () => !stopped() && epoch === control.generation()
  return {
    id: 1,
    destroyed: () => !current(),
    send: (channel, push) => {
      if (current()) events.emit(channel, push)
    },
  }
}
/** Desktop's native hooks, which a page answers with nothing. */
const NATIVE_ONLY = {
  pathForFile: () => '',
  spellingSuggestions: () => null,
} satisfies Partial<PhosphorApi>
/** The `window.phosphor` surface over the adapter's invoke and events. */
function browserSurface(
  invoke: PhosphorApi['invoke'],
  events: ReturnType<typeof createBrowserEvents>,
  platform: PhosphorApi['platform'] | undefined,
): PhosphorApi {
  return {
    platform:
      platform ??
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
    onHostResourceChanged: (listener) => events.on('hostResource', listener),
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
    onFileDownloadProgress: (listener) => events.on('file-download', listener),
    onOpsChanged: (listener) => events.on('ops', listener),
    // The browser has no This Mac: nothing is ever pushed here.
    onLocalMachineChanged: (listener) => events.on('local-machine', listener),
    ...NATIVE_ONLY,
  }
}
/** Install api on window BEFORE importing the shared UI; call start after installation. */
export function createBrowserApi(options: BrowserApiOptions = {}): {
  api: PhosphorApi
  start(): Promise<void>
  dispose(): void
} {
  const events = createBrowserEvents()
  const prefs = browserPreferences(options)
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
    signInError: options.signInError,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    navigate: options.navigate ?? ((path) => location.assign(path)),
    changed: (view) => {
      events.emit('account', view)
      events.emit('machines', undefined)
    },
    invalidate: (owner) => {
      laneMoves.abort()
      fileBytes.clear()
      // Disposing (closing the page) is no sign-out: push scopes stay.
      if (!stopped) push.accountChanged(owner)
      terminals.clear()
      lanes.clear()
      hosts.clear()
      resources.clear()
      void prefs.adoptOwner(owner)
      drafts.clearOwner()
      events.clearSessions()
      attention.clear()
    },
  })
  const offClicks = attachNotificationClicks(options.navigateNotification ?? navigateNotification)
  const attention = createBrowserAttention({
    connection: (hostId) => hosts.connection(hostId),
    label: (hostId) => hosts.label(hostId),
    publish: (notice) => events.emit('attention', notice),
    generation: () => (stopped ? undefined : control.generation()),
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
      push.sync()
    },
    resourceChanged: (event) => events.emit('hostResource', event),
    routinesChanged: (hostId) => events.emit('routines', { machine: `host:${hostId}` }),
    attention: attention.receive,
  })
  const push = createBrowserPush({
    hosts,
    session: control.session,
    changed: () => events.emit('hosts', undefined),
  })
  const lanes = createRemoteLanes({
    identity: options.identity,
    connection: hosts.connection,
    present: hosts.present,
    label: hosts.label,
    changed: () => events.emit('hosts', undefined),
  })
  const laneMoves = browserLaneMoves(hosts, prefs)
  const resources = createBrowserResources(hosts, lanes)
  const fileBytes = createBrowserFileBytes({
    lanes,
    progress: (progress) => {
      if (!stopped) events.emit('file-download', progress)
    },
  })
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
    laneMoves,
    fileBytes,
    push,
    window: () => tabWindow(control, events, () => stopped),
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
  const api = browserSurface(invoke, events, options.platform)
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
        // Another tab signed out: drop local state, then let Control say who is signed in.
        offInvalidation =
          invalidation?.subscribe(() => {
            control.invalidate()
            refreshQuietly()
          }) ?? (() => {})
        push.start()
        poll = setInterval(refreshQuietly, DIRECTORY_POLL_MS)
        clock = setInterval(hosts.reconcile, 5000)
      }
      // Only an outage rejects here. It is no sign-out: the sign-in screen says the check is
      // retrying, and the poll and resume events retry it.
      await refresh().catch(() => {})
    },
    dispose() {
      if (stopped) return
      stopped = true
      clearInterval(poll)
      clearInterval(clock)
      offClicks()
      push.dispose()
      offLifecycle()
      offInvalidation()
      invalidation?.close()
      control.dispose()
      fileBytes.clear()
      terminals.clear()
      hosts.dispose()
      lanes.clear()
      resources.clear()
      events.clear()
    },
  }
}
