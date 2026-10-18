import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap } from '../ipc'
import type {
  RpcCommand,
  RpcResponse,
  ExtensionUIResponse,
  RpcSlashCommand,
  ThinkingLevelMap,
  ModelCost,
} from '../rpc'
import type {
  AgentSettingsHealth,
  CodexUsageResult,
  CreateSessionOptions,
  LiveSessionInfo,
  PiHealth,
  LoginProviderId,
  SubscriptionProviderStatus,
  PiResources,
} from '../models'
export interface BaselinePiInvokeMap {
  'pi:health': { args: []; result: PiHealth }

  'pi:createSession': { args: [CreateSessionOptions]; result: LiveSessionInfo }

  'pi:command': { args: [sessionId: string, command: RpcCommand]; result: RpcResponse }

  'pi:extensionUiResponse': {
    args: [sessionId: string, response: ExtensionUIResponse]
    result: void
  }

  'pi:disposeSession': { args: [sessionId: string]; result: void }

  /**
   * Live pi subprocesses main currently owns. A freshly loaded renderer calls
   * this to re-adopt sessions it orphaned (reload, crash) instead of leaving
   * ~200 MB processes stranded until quit — and to avoid spawning a SECOND
   * process for a session file an orphan still owns.
   */
  'pi:listLiveSessions': { args: []; result: LiveSessionInfo[] }

  /** One-shot `pi -p` completion that names a session after its first message. */
  'pi:generateTitle': {
    args: [workspacePath: string, message: string, existingNames: string[]]
    result: string | null
  }

  /** Effective settings: global merged with the workspace override (pi semantics). */
  'pi:agentSettings': { args: [workspacePath?: string]; result: Record<string, unknown> }

  /** Each scope's settings as written on disk — for editors, never merged. */
  'pi:agentSettingsScoped': {
    args: [workspacePath?: string]
    result: { global: Record<string, unknown>; project: Record<string, unknown> | null }
  }

  /**
   * The slash commands pi resolves for a folder, with no live session yet.
   *
   * A session gets its own list from `get_commands` at bootstrap; the home
   * composer has no session to ask, so it asks a throwaway pi instead
   * (`electron/pi/commands.ts`, cached a minute per folder). `error` is set,
   * with an empty list, when pi could not be asked at all — pi missing, or
   * the probe timed out — so the menu can say so instead of rendering the
   * same nothing it renders while the answer is still on its way.
   *
   * Main broadcasts `pi:commandsChanged` (see `PhosphorApi.onPiCommandsChanged`)
   * after anything that changes the answer; the renderer drops what it holds
   * and asks again on the next `/`.
   */
  'pi:commands': {
    args: [workspacePath?: string]
    result: { commands: RpcSlashCommand[]; error?: string }
  }

  /**
   * pi's model catalogue, for pickers with no live session yet.
   *
   * `source` is part of the answer, not a detail: when pi cannot be asked, the
   * fallback is whatever the user declared in models.json, which is a handful
   * of models rather than pi's full list. Returning that as if it were the
   * catalogue is how a configured default came to render as "unavailable" with
   * nothing anywhere saying pi had not been reached.
   */
  'pi:catalogueModels': {
    args: []
    result: {
      models: {
        id: string
        name: string
        provider: string
        reasoning: boolean
        thinkingLevelMap?: ThinkingLevelMap | null
        /** Absent when the models.json fallback answered — never guessed at. */
        contextWindow?: number
        maxTokens?: number
        cost?: ModelCost
        input?: string[]
      }[]
      source: 'pi' | 'config'
    }
  }

  'pi:readConfigFile': {
    args: [name: 'settings' | 'models' | 'web-search']
    result: { path: string; content: string }
  }

  'pi:writeConfigFile': {
    args: [name: 'settings' | 'models' | 'web-search', content: string]
    result: void
  }

  /** pi-web-access config (web-search.json), with file health for the tab. */
  'pi:webSearchConfig': {
    args: []
    result: {
      path: string
      exists: boolean
      malformed: boolean
      error?: string
      config: Record<string, unknown>
    }
  }

  'pi:patchWebSearchConfig': { args: [patch: Record<string, unknown>]; result: void }

  'pi:patchAgentSettings': {
    args: [
      scope: 'global' | 'project',
      workspacePath: string | undefined,
      patch: Record<string, unknown>,
    ]
    result: void
  }

  'pi:checkAgentSettings': { args: [workspacePath?: string]; result: AgentSettingsHealth }

  'pi:listResources': { args: []; result: PiResources }

  /** Which subscription providers pi is signed into, via `pi auth check --json`. */
  'pi:subscriptionAuth': { args: []; result: SubscriptionProviderStatus[] }

  'pi:codexUsage': { args: [force?: boolean]; result: CodexUsageResult }

  /**
   * A PTY running pi interactively so the user can complete `/login`.
   *
   * This exists because pi exposes sign-in nowhere else: no RPC command, no
   * `pi login` subcommand, and pi-ai no longer exports its OAuth runtime.
   * Hosting pi's own TUI is the only path that does not couple Phosphor to pi
   * internals. Drive it with the ordinary `pty:*` channels once created.
   */
  'pi:loginTerminal': { args: [cols: number, rows: number]; result: { ptyId: string } }

  /**
   * Sign into one provider without showing a terminal at all.
   *
   * Same TUI underneath as `pi:loginTerminal`, driven off-screen by
   * `electron/pi/login-flow.ts`: progress arrives on the `pi:loginState`
   * event, and main opens the browser itself once pi produces a URL. Resolves
   * as soon as the flow has *started*; the outcome is an event, because the
   * middle of it is a human in a browser.
   *
   * `pi:loginTerminal` stays for the escape hatch — a provider that asks
   * something this driver does not know how to answer.
   */
  'pi:startLogin': { args: [providerId: LoginProviderId]; result: void }

  /** Abort a `pi:startLogin` in progress. No-op if nothing is running. */
  'pi:cancelLogin': { args: [providerId: LoginProviderId]; result: void }
}
it('freezes pi channel tuples and results through ipc.ts', () => {
  expectTypeOf<Pick<IpcInvokeMap, keyof BaselinePiInvokeMap>>().toEqualTypeOf<BaselinePiInvokeMap>()
})
