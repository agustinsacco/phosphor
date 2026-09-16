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
 *
 * One cache, two readers. `pi:commands` (the home composer) and the Skills
 * page both need this answer; each used to spawn its own pi for it. The cache
 * is keyed by folder — project prompts and `<ws>/.pi/skills` differ per
 * folder — and cleared by `invalidateCommandCaches` from every mutation that
 * changes the answer (`electron/ipc/pi-config-handlers.ts`).
 */
import { PiRpcClient } from './rpc-client'
import { createTtlCache, type TtlCache } from './ttl-cache'
import type { RpcResponse, RpcResponseDataMap, RpcSlashCommand } from '@shared/rpc'

const RPC_TIMEOUT_MS = 20_000

/**
 * How long a folder's resolved command list is believed.
 *
 * Shorter than the catalogue's: a skill or prompt is a file the user just
 * wrote, and "I added it and Phosphor still doesn't see it" is the failure
 * that matters here. One spawn a minute per folder, only while someone is
 * typing `/` on a home screen — and the mutations Phosphor itself performs
 * do not wait for the minute, they invalidate.
 */
const COMMANDS_TTL_MS = 60_000

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

type Prober = (options: CommandProbeOptions) => Promise<RpcSlashCommand[]>

interface CacheEntry {
  cache: TtlCache<RpcSlashCommand[]>
  /** Re-read on every load, so a pi installed after the first miss is used. */
  options: CommandProbeOptions
  probe: Prober
}

const commandCaches = new Map<string, CacheEntry>()

/**
 * `probeCommands`, remembered per folder for `COMMANDS_TTL_MS`.
 *
 * `fresh` re-asks now and stores the answer — the Skills page uses it so a
 * skill the user just created appears without waiting out the TTL, while
 * still leaving a warm answer for the next `/`. Failures are never cached
 * (`createTtlCache`), so a probe that timed out is retried on the next call.
 * `probe` is injectable for tests only.
 */
export async function probeCommandsCached(
  options: CommandProbeOptions,
  { fresh = false, probe = probeCommands }: { fresh?: boolean; probe?: Prober } = {},
): Promise<RpcSlashCommand[]> {
  const key = options.workspacePath ?? ''
  let entry = commandCaches.get(key)
  if (!entry) {
    const created = { options, probe } as CacheEntry
    created.cache = createTtlCache(() => created.probe(created.options), COMMANDS_TTL_MS)
    commandCaches.set(key, created)
    entry = created
  } else {
    entry.options = options
    entry.probe = probe
  }
  if (fresh) entry.cache.invalidate()
  return entry.cache.get()
}

/** Forget every folder's answer; the next call re-probes. */
export function invalidateCommandCaches(): void {
  commandCaches.clear()
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
