import { expectTypeOf, it } from 'vitest'
import type { AppPrefs } from '../models'
import type {
  IpcInvokeMap,
  IpcInvokeChannel,
  HostAttention,
  PhosphorApi,
  PhosphorPlatform,
} from '../ipc'
import type { RpcCommand, RpcResponse, RpcResponseDataMap } from '../rpc'
import type { AccountView } from '../account'
import type { VoiceStatus } from '../voice'
import type {
  ConnectorAuthPush,
  ClaudeLoginState,
  LoginFlowState,
  SessionPush,
  UpdateState,
} from '../models'

/** The API surface exposed on window.phosphor by the preload script. */
/** Host platform, normalized. Anything exotic (bsd, sunos) reads as 'linux'. */
export type BaselinePhosphorPlatform = 'darwin' | 'win32' | 'linux'

export interface BaselinePhosphorApi {
  /**
   * The host platform, synchronously. Key-hint labels are rendered during the
   * first paint, so this cannot be an async `invoke` without every shortcut
   * flashing the wrong modifier first.
   */
  platform: BaselinePhosphorPlatform

  invoke<C extends IpcInvokeChannel>(
    channel: C,
    ...args: IpcInvokeMap[C]['args']
  ): Promise<IpcInvokeMap[C]['result']>

  /**
   * Subscribe to a live session's pushed events.
   * Returns an unsubscribe function.
   */
  onSessionPush(sessionId: string, listener: (push: SessionPush) => void): () => void

  /** Session-dir change notifications (chokidar); returns unsubscribe. */
  onSessionsChanged(listener: (payload: { workspacePath: string }) => void): () => void
  /** Invalidation only; reconnecting windows read an authoritative snapshot. */
  onRoutinesChanged(listener: (event?: { machine?: string }) => void): () => void

  /**
   * The set of slash commands pi would resolve has changed — a package was
   * installed or removed, an MCP server added or reconnected, a skill written. Fired from
   * main after the mutation, for every window. Listeners drop their cached
   * `pi:commands` answers and re-ask live sessions for `get_commands`.
   */
  onPiCommandsChanged(listener: () => void): () => void

  /** Workspace file-change notifications; returns unsubscribe. */
  onFsChanged(listener: (payload: { workspacePath: string; paths: string[] }) => void): () => void

  /** Package job output stream (pi install/remove/update, pi self-install). */
  onPackagesJobOutput(jobId: string, listener: (data: string) => void): () => void
  /** Package job completion; exit code 0 means success. */
  onPackagesJobExit(jobId: string, listener: (exitCode: number) => void): () => void

  /** PTY output stream; returns unsubscribe. */
  onPtyData(ptyId: string, listener: (data: string) => void): () => void
  /** PTY exit notification; returns unsubscribe. */
  onPtyExit(ptyId: string, listener: (exitCode: number) => void): () => void
  /** Busy map broadcast (ptyId → foreground process running); unsubscribe. */
  onPtyStatus(listener: (statuses: Record<string, boolean>) => void): () => void
  /** Update lifecycle changes (checking / downloading / ready to install). */
  onUpdateEvent(listener: (state: UpdateState) => void): () => void
  /** Progress of a background `mcp:authorize`; returns unsubscribe. */
  onMcpAuthState(listener: (push: ConnectorAuthPush) => void): () => void
  onPiLoginState(listener: (state: LoginFlowState) => void): () => void
  /** Progress of a background `claude:startLogin`; returns unsubscribe. */
  onClaudeLoginState(listener: (state: ClaudeLoginState) => void): () => void
  /** The Phosphor account changed: signing in, signed in or out, preview toggled. */
  onAccountChanged(listener: (view: AccountView) => void): () => void
  /** A change signal only. Refetch the enrolled machines through control:machines. */
  onMachinesChanged(listener: () => void): () => void
  onHostsChanged(listener: () => void): () => void
  /** Attention from any Host (49). */
  onHostAttention(listener: (event: HostAttention) => void): () => void
  /** A notification was clicked: open this remote lane. */
  onHostOpenLane(listener: (target: { hostId: string; laneId: string }) => void): () => void
  /** Voice prefs, download progress and readiness; returns unsubscribe. */
  onVoiceStatus(listener: (status: VoiceStatus) => void): () => void

  /**
   * Absolute path for a dropped File (Electron `webUtils`). Non-image
   * attachments are handed to pi as paths, so it needs the real location.
   */
  pathForFile(file: File): string

  /**
   * Spelling suggestions for one word, from Chromium's spellchecker through
   * `webFrame`: null when the word is spelled correctly (or no dictionary is
   * loaded), otherwise the suggestions, possibly none. Synchronous so the
   * right-click menu can open at once. Not the `context-menu` event's
   * `dictionarySuggestions`, which came back empty on macOS with the spelling
   * language set to Automatic (electron#24455) while this answered.
   */
  spellingSuggestions(word: string): string[] | null

  /** Convenience wrapper: send an RPC command and get the typed response data. */
  piCommand<T extends RpcCommand['type']>(
    sessionId: string,
    command: Extract<RpcCommand, { type: T }>,
  ): Promise<RpcResponse<RpcResponseDataMap[T]>>
}

it('freezes the preload API, global Window and generic signatures', () => {
  expectTypeOf<PhosphorApi>().toEqualTypeOf<BaselinePhosphorApi>()
  expectTypeOf<Window['phosphor']>().toEqualTypeOf<BaselinePhosphorApi>()
  expectTypeOf<PhosphorPlatform>().toEqualTypeOf<BaselinePhosphorPlatform>()
})

// The callback is typechecked, not executed: no preload exists in Node.
function inferApiCalls(api: PhosphorApi): void {
  expectTypeOf(api.invoke('app:getPrefs')).toEqualTypeOf<Promise<AppPrefs>>()
  expectTypeOf(api.invoke('pi:agentSettings')).toEqualTypeOf<Promise<Record<string, unknown>>>()
  expectTypeOf(api.invoke('sessions:delete', undefined)).toEqualTypeOf<Promise<string[]>>()
  expectTypeOf(api.piCommand('session', { type: 'get_state' })).toEqualTypeOf<
    Promise<RpcResponse<RpcResponseDataMap['get_state']>>
  >()
  expectTypeOf(api.piCommand('session', { type: 'prompt', message: 'hello' })).toEqualTypeOf<
    Promise<RpcResponse<RpcResponseDataMap['prompt']>>
  >()
}
it('typechecks inferred invoke and piCommand results without a runtime bridge', () => {
  expectTypeOf(inferApiCalls).parameter(0).toEqualTypeOf<Window['phosphor']>()
})

import type {
  PhosphorApi as LeafPhosphorApi,
  PhosphorPlatform as LeafPhosphorPlatform,
} from './api'
it('preserves API leaf identity and every subscription unsubscribe signature', () => {
  expectTypeOf<LeafPhosphorApi>().toEqualTypeOf<BaselinePhosphorApi>()
  expectTypeOf<LeafPhosphorPlatform>().toEqualTypeOf<BaselinePhosphorPlatform>()
  type Subscriptions = Extract<keyof LeafPhosphorApi, `on${string}`>
  type Unsubscribes = { [K in Subscriptions]: ReturnType<LeafPhosphorApi[K]> }[Subscriptions]
  expectTypeOf<Unsubscribes>().toEqualTypeOf<() => void>()
})
