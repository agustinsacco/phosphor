import { PiRpcClient } from './rpc-client'
import { parseAuthNotice, parseOAuthPrompt } from '@shared/connectors'
import type { ConnectorAuthState } from '@shared/models'
import { log } from '../debug-log'

/**
 * Authorizing an MCP connector without a session.
 *
 * The MCP adapter's OAuth flow is an interactive extension command
 * (`/mcp-auth <server>`), so it needs a pi process. It used to need one the
 * user had already started, which made Settings → Connectors useless on a
 * fresh launch — the exact moment someone goes there.
 *
 * This spawns a throwaway `pi --mode rpc --no-session` for the flow and kills
 * it when the flow settles, the same machinery `model-catalogue.ts` uses to
 * ask a question with nothing running. `--no-session` matters twice: no
 * session file appears in the sidebar, and the process is never in the
 * registry, so nothing projects it as work in progress.
 *
 * No tokens are spent. `/mcp-auth` is an extension command, which pi runs
 * immediately without an LLM call, and this process is never prompted with
 * anything else.
 *
 * The rule from docs/mcp.md holds here too: **never auto-answer
 * the adapter's authorization prompt.** pi's RPC has no server→client cancel,
 * so an empty answer wins the race against the loopback callback and kills a
 * flow that already succeeded. The pending request is simply left pending, and
 * disposing the process collects it.
 */

/** How long a flow may sit unanswered before the process is reclaimed. */
const AUTH_TIMEOUT_MS = 10 * 60 * 1000

export interface ConnectorAuthOptions {
  serverName: string
  /** pi's cwd — decides which project-scope mcp.json files apply. */
  cwd: string
  binaryPath: string
  prefixArgs?: string[]
  extensions?: string[]
  /** Spawn environment; the caller resolves the login-shell PATH. */
  env?: Record<string, string>
  /** Report progress. Called at least once, and once more on settle. */
  onState: (state: ConnectorAuthState) => void
  /** Open the authorization page. Injected so tests never launch a browser. */
  openUrl: (url: string) => void
  timeoutMs?: number
}

interface ActiveRun {
  client: PiRpcClient
  /** Pending `extension_ui_request` id, once the adapter has asked. */
  requestId?: string
  timer: NodeJS.Timeout
  /**
   * End the run. `state` is omitted for a cancel, which must resolve the
   * caller's promise without reporting a phase the UI has already dropped —
   * an unresolved promise here used to leak the process handle with it.
   */
  finish: (state?: ConnectorAuthState) => void
}

const runs = new Map<string, ActiveRun>()

/** Is a headless flow already in flight for this server? */
export function hasConnectorAuthRun(serverName: string): boolean {
  return runs.has(serverName)
}

/**
 * Start a headless authorization. Resolves when the flow settles — the caller
 * does not need the result, since every transition is reported through
 * `onState`, but awaiting it keeps tests honest.
 */
export async function startConnectorAuth(options: ConnectorAuthOptions): Promise<void> {
  const { serverName, onState, openUrl } = options
  await cancelConnectorAuth(serverName)

  const client = new PiRpcClient({
    cwd: options.cwd,
    binaryPath: options.binaryPath,
    ...(options.prefixArgs ? { prefixArgs: options.prefixArgs } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
    noSession: true,
    ...(options.env ? { env: options.env } : {}),
  })

  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (state?: ConnectorAuthState): void => {
      if (settled) return
      settled = true
      const run = runs.get(serverName)
      if (run) {
        clearTimeout(run.timer)
        runs.delete(serverName)
      }
      if (state) onState(state)
      void client.dispose().finally(() => resolve())
    }

    const timer = setTimeout(
      () => finish({ phase: 'failed', message: 'Authorization timed out.' }),
      options.timeoutMs ?? AUTH_TIMEOUT_MS,
    )
    timer.unref()
    runs.set(serverName, { client, timer, finish })

    client.on('extension-ui', (request) => {
      if (request.method === 'input') {
        const prompt = parseOAuthPrompt(request.title)
        // Another server's prompt cannot appear here: this process was started
        // for one `/mcp-auth`, and nothing else runs in it.
        if (!prompt) return
        const run = runs.get(serverName)
        if (run) run.requestId = request.id
        onState({ phase: 'awaiting-browser', authorizationUrl: prompt.authorizationUrl })
        openUrl(prompt.authorizationUrl)
        return
      }
      if (request.method === 'notify') {
        const notice = parseAuthNotice(request.message)
        if (!notice) return
        finish(
          notice.outcome === 'success'
            ? { phase: 'connected' }
            : { phase: 'failed', message: notice.detail ?? 'Authorization failed.' },
        )
      }
    })

    client.on('exit', ({ code, expected }) => {
      if (expected) return
      finish({
        phase: 'failed',
        message: `pi exited before authorization finished (code ${String(code)}).`,
      })
    })

    client.on('stderr', (text) => log('connectors', 'pi stderr', { serverName, text }))

    try {
      client.spawn()
    } catch (error) {
      finish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      return
    }

    onState({ phase: 'starting' })
    void client.request({ type: 'prompt', message: `/mcp-auth ${serverName}` }).then(
      (response) => {
        if (!response.success) {
          finish({
            phase: 'failed',
            message:
              response.error ?? 'pi refused /mcp-auth — is the pi-mcp-adapter package installed?',
          })
        }
      },
      (error: unknown) => {
        finish({
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
  })
}

/**
 * Answer the adapter's prompt with a pasted callback URL. The fallback for a
 * loopback callback that never arrived (port taken, browser on another host).
 */
export function submitConnectorCallback(serverName: string, url: string): boolean {
  const run = runs.get(serverName)
  if (!run?.requestId) return false
  run.client.respondToExtensionUI({
    type: 'extension_ui_response',
    id: run.requestId,
    value: url.trim(),
  })
  return true
}

/**
 * Abandon a flow. Answering `cancelled` first is deliberate and is the *only*
 * place Phosphor answers the prompt: it makes the adapter tear down its own
 * pending callback rather than leaving a listener on the loopback port.
 */
export async function cancelConnectorAuth(serverName: string): Promise<void> {
  const run = runs.get(serverName)
  if (!run) return
  if (run.requestId) {
    run.client.respondToExtensionUI({
      type: 'extension_ui_response',
      id: run.requestId,
      cancelled: true,
    })
  }
  // Settles the start promise too, and disposes the process with it.
  run.finish()
  await run.client.dispose()
}

/** Kill every in-flight flow (app quit). */
export function disposeConnectorAuth(): void {
  for (const [serverName] of runs) void cancelConnectorAuth(serverName)
}
