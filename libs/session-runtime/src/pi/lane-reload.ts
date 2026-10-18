import { randomBytes } from 'node:crypto'
import {
  LANE_RELOAD_COMMAND,
  LANE_RELOAD_STATUS_KEY,
  type LaneReloadOutcome,
} from '@phosphor/pi-extensions/lane-reload'
import type { ExtensionUIRequest } from '@shared/rpc'
import type { RuntimeLog } from '../file-log'
import type { PiRpcClient } from './rpc-client'

export interface LaneReloadDeps {
  /**
   * What a lane's extensions read when they start (MCP and package config),
   * from the lane's own folder. Cheap: it runs before every prompt. Null when
   * it cannot be read, which never triggers a reload.
   */
  fingerprint: (cwd: string) => Promise<string | null>
  log: RuntimeLog
  /** A reload took: anything derived from the lane's extensions (its slash commands) is stale. */
  onApplied?: (sessionId: string) => void
}

type ReloadClient = Pick<PiRpcClient, 'request' | 'on' | 'off'>

export type BeforePromptResult = LaneReloadOutcome | 'unchanged' | 'unsupported'

interface ReloadState {
  deps: LaneReloadDeps
  loaded: Map<string, string>
}

async function safeRead(state: ReloadState, cwd: string): Promise<string | null> {
  try {
    return await state.deps.fingerprint(cwd)
  } catch (error) {
    state.deps.log('pi', 'lane config fingerprint failed', { cwd, error: String(error) })
    return null
  }
}

/** A lane is followed from its spawn until its process exits. Untracked lanes never reload. */
function track(
  state: ReloadState,
  sessionId: string,
  fingerprint: string | null,
  client: Pick<PiRpcClient, 'on'>,
): void {
  if (fingerprint === null) return
  state.loaded.set(sessionId, fingerprint)
  client.on('exit', () => state.loaded.delete(sessionId))
}

async function sendReload(
  state: ReloadState,
  sessionId: string,
  client: ReloadClient,
): Promise<LaneReloadOutcome> {
  const token = randomBytes(8).toString('hex')
  let outcome: LaneReloadOutcome | undefined
  const onStatus = (request: ExtensionUIRequest): void => {
    if (request.method !== 'setStatus' || request.statusKey !== LANE_RELOAD_STATUS_KEY) return
    try {
      const status = JSON.parse(request.statusText ?? '') as { token?: string; outcome?: string }
      if (status.token === token) outcome = status.outcome as LaneReloadOutcome
    } catch {
      // Not ours.
    }
  }
  client.on('extension-ui', onStatus)
  const started = Date.now()
  try {
    // Answered only once the command handler returns, reload included; the
    // status lines it published arrive on stdout before the answer.
    const response = await client.request({
      type: 'prompt',
      message: `/${LANE_RELOAD_COMMAND} ${token}`,
    })
    if (!response.success) outcome = 'failed'
  } finally {
    client.off('extension-ui', onStatus)
  }
  const result = outcome ?? 'failed'
  state.deps.log('pi', 'lane reload', { sessionId, outcome: result, ms: Date.now() - started })
  return result
}

async function reloadIfChanged(
  state: ReloadState,
  sessionId: string,
  client: ReloadClient,
  cwd: string,
): Promise<BeforePromptResult> {
  const before = state.loaded.get(sessionId)
  if (before === undefined) return 'unchanged'
  const current = await safeRead(state, cwd)
  if (current === null || current === before) return 'unchanged'

  // An unknown slash command is sent to the model as text. Ask first; this
  // only runs when something changed.
  const commands = await client.request({ type: 'get_commands' })
  if (!commands.success) return 'failed'
  if (!commands.data?.commands.some((c) => c.name === LANE_RELOAD_COMMAND)) {
    state.deps.log('pi', 'lane cannot reload; config change waits for a new lane', { sessionId })
    state.loaded.set(sessionId, current)
    return 'unsupported'
  }

  const result = await sendReload(state, sessionId, client)
  if (result === 'applied') {
    state.loaded.set(sessionId, current)
    state.deps.onApplied?.(sessionId)
  }
  return result
}

/**
 * Call only while the lane is idle, right before a prompt that starts a
 * turn. Never throws: the prompt goes ahead whatever happens here.
 */
async function beforePrompt(
  state: ReloadState,
  sessionId: string,
  client: ReloadClient,
  cwd: string,
): Promise<BeforePromptResult> {
  try {
    return await reloadIfChanged(state, sessionId, client, cwd)
  } catch (error) {
    state.deps.log('pi', 'lane reload failed', { sessionId, error: String(error) })
    return 'failed'
  }
}

/**
 * Brings configuration changes into a running lane before its next turn
 * (`pi-ext/lane-reload.ts` does the reload inside pi).
 *
 * Each lane remembers the fingerprint it was started with; a prompt whose
 * fingerprint differs reloads first. Nothing changed costs one fingerprint
 * read. A refusal (mid-run, live sub-agent work) or any failure leaves the
 * remembered value alone, so the next prompt tries again, and never holds up
 * the prompt itself.
 */
export function createLaneReload(deps: LaneReloadDeps) {
  const state: ReloadState = { deps, loaded: new Map() }
  return {
    // Read before the spawn, so a change made while the lane starts is not missed.
    capture: (cwd: string) => safeRead(state, cwd),
    track: (sessionId: string, fingerprint: string | null, client: Pick<PiRpcClient, 'on'>) =>
      track(state, sessionId, fingerprint, client),
    beforePrompt: (sessionId: string, client: ReloadClient, cwd: string) =>
      beforePrompt(state, sessionId, client, cwd),
  }
}

export type LaneReload = ReturnType<typeof createLaneReload>
