/**
 * What slash commands pi resolves for a folder, without a session.
 *
 * A live session learns its own list over the `get_commands` RPC at bootstrap
 * (`src/stores/sessions.ts`), which is why the chat composer has a `/` menu and
 * the home composer had none: before the first prompt there is no pi process to
 * ask. This module asks the same question of a throwaway
 * `pi --mode rpc --no-session` — the probe the skills page and the model
 * catalogue already use, no tokens spent — so the home composer can offer the
 * same commands the session it is about to start will have.
 *
 * Bundled Phosphor extensions register no commands, so `--no-session` (no `-e`)
 * resolves the same list a real session would.
 */
import { PiRpcClient } from './rpc-client'
import type { RpcResponse, RpcResponseDataMap, RpcSlashCommand } from '@shared/rpc'

const RPC_TIMEOUT_MS = 20_000

export interface CommandProbeOptions {
  workspacePath?: string
  /** Resolved pi binary; omitted (pi missing) means no list at all. */
  binaryPath?: string
  /** Stub prefix under e2e — same contract as every other pi spawn. */
  prefixArgs?: string[]
  env?: Record<string, string>
}

/** Ask a throwaway pi for the commands it resolves in `workspacePath`. */
export async function probeCommands(options: CommandProbeOptions): Promise<RpcSlashCommand[]> {
  if (!options.binaryPath && !options.prefixArgs) return []
  const client = new PiRpcClient({
    cwd: options.workspacePath ?? process.cwd(),
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.prefixArgs ? { prefixArgs: options.prefixArgs } : {}),
    noSession: true,
    ...(options.env ? { env: options.env } : {}),
  })
  client.spawn()
  try {
    const response = (await withTimeout(
      client.request({ type: 'get_commands' }),
      RPC_TIMEOUT_MS,
    )) as RpcResponse<RpcResponseDataMap['get_commands']>
    if (!response.success || !response.data) return []
    return response.data.commands
  } finally {
    await client.dispose()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('commands probe timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
