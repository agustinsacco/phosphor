import { PiRpcClient } from './rpc-client'
import { parseReconnectNotice, type ConnectorCheckResult } from '@shared/connectors'
import { log } from '../debug-log'

/**
 * Testing whether a connector is actually up, with nothing open.
 *
 * Per-server MCP state reaches Phosphor only from the adapter running inside a
 * live session, so Settings could not answer "is this connector working?" —
 * it showed `state unknown`, or a stale `Signed in · idle` that says nothing
 * about the server being reachable right now.
 *
 * The adapter already has the probe: `/mcp reconnect <server>` closes the
 * connection, opens a fresh one and reports the outcome. So this spawns a
 * throwaway `pi --mode rpc --no-session` (the same machinery as
 * `connector-auth.ts`), sends that one extension command — no model call, no
 * tokens — reads the adapter's notify, and kills the process.
 *
 * The rule from connector-auth.ts still holds: **never answer an extension
 * input request.** A reconnect on an unauthorized server only notifies, but a
 * future adapter version could prompt, and answering it would abort a flow
 * that had already succeeded. Pending requests are left pending and collected
 * with the process.
 */

/** A reconnect that opens a fresh HTTP connection; slow servers exist. */
const CHECK_TIMEOUT_MS = 45 * 1000

export interface ConnectorCheckOptions {
  serverName: string
  /** pi's cwd — decides which project-scope mcp.json files apply. */
  cwd: string
  binaryPath: string
  prefixArgs?: string[]
  extensions?: string[]
  env?: Record<string, string>
  timeoutMs?: number
}

/**
 * Run one connection test. Always resolves: an unparseable or absent verdict
 * becomes `unknown` with the reason, never a wrong badge.
 */
export function checkConnector(options: ConnectorCheckOptions): Promise<ConnectorCheckResult> {
  const { serverName } = options
  const client = new PiRpcClient({
    cwd: options.cwd,
    binaryPath: options.binaryPath,
    ...(options.prefixArgs ? { prefixArgs: options.prefixArgs } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
    noSession: true,
    ...(options.env ? { env: options.env } : {}),
  })

  return new Promise<ConnectorCheckResult>((resolve) => {
    let settled = false
    const finish = (result: ConnectorCheckResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void client.dispose().finally(() => resolve(result))
    }

    const timer = setTimeout(
      () =>
        finish({
          serverName,
          outcome: 'unknown',
          detail: 'The adapter did not answer in time.',
        }),
      options.timeoutMs ?? CHECK_TIMEOUT_MS,
    )
    timer.unref()

    client.on('extension-ui', (request) => {
      if (request.method !== 'notify') return
      const notice = parseReconnectNotice(request.message ?? '')
      // Reconnect also emits a "tools skipped" warning, and this process asked
      // about exactly one server, so anything unrecognised is noise.
      if (!notice) return
      finish(notice)
    })

    client.on('exit', ({ code, expected }) => {
      if (expected) return
      finish({
        serverName,
        outcome: 'unknown',
        detail: `pi exited before the test finished (code ${String(code)}).`,
      })
    })

    client.on('stderr', (text) => log('connectors', 'pi stderr', { serverName, text }))

    try {
      client.spawn()
    } catch (error) {
      finish({
        serverName,
        outcome: 'unknown',
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }

    void client.request({ type: 'prompt', message: `/mcp reconnect ${serverName}` }).then(
      (response) => {
        if (!response.success) {
          finish({
            serverName,
            outcome: 'unknown',
            detail: response.error ?? 'pi refused /mcp — is the pi-mcp-adapter package installed?',
          })
        }
      },
      (error: unknown) => {
        finish({
          serverName,
          outcome: 'unknown',
          detail: error instanceof Error ? error.message : String(error),
        })
      },
    )
  })
}
