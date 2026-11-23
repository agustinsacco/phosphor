import { randomBytes, randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { CONTROL_ROUTES as R } from '@phosphor/shared/control-api'
import { createApp } from '../../app'
import { parseConfig } from '../../config'
import { dependencies, signingKey, userId } from '../../test-support'

export const beat = {
  seq: 1,
  state: 'running',
  hostVersion: '1.0.0',
  uptimeSec: 1,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  lanes: { running: 0, waiting: 0 },
  endpoint: null,
}

/** A signed caller machine, a target and grant keys, with every RPC answered from `results`. */
export function machineSetup() {
  const deps = dependencies()
  const seed = randomBytes(32).toString('base64url')
  deps.config = parseConfig({
    SUPABASE_SECRET_KEY: randomBytes(32).toString('hex'),
    CONTROL_GRANT_KEYS: `current=${seed}`,
  })
  const callerId = randomUUID()
  const targetId = randomUUID()
  const principal = { id: randomUUID(), sid: randomUUID() }
  const callerKey = signingKey()
  const targetKey = signingKey()
  const results: Record<string, unknown> = {
    control_host_key: { outcome: 'active', publicKey: callerKey.publicKey },
    control_host_heartbeat: { outcome: 'accepted' },
    control_host_revocations: {
      epoch: 2,
      ownerId: userId,
      revoked: { sessions: [], clients: [] },
    },
    control_machine_beat: { outcome: 'ok', machineReach: true, revoked: [] },
    control_machine_grant_issue: {
      outcome: 'issued',
      ownerId: userId,
      epoch: 3,
      publicKey: targetKey.publicKey,
      endpoint: 'https://bravo.ts.net',
      sid: principal.sid,
      client: { id: principal.id, label: 'Alpha' },
    },
    control_machine_directory: {
      outcome: 'ok',
      serverTime: '2026-11-22T12:00:00.000Z',
      self: { id: callerId, label: 'Alpha', machineReach: true },
      machines: [
        {
          id: targetId,
          label: 'Bravo',
          hostVersion: '1.0.0',
          lastSeenAt: '2026-11-22T12:00:00.000Z',
          state: 'running',
          readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
          machineGrants: true,
          machineReach: true,
          reachable: true,
        },
      ],
    },
  }
  vi.mocked(deps.supabase.rpc).mockImplementation(async (name) => results[name])
  const app = createApp(deps)
  /** Every request comes from the same client address, so they share per-IP budgets. */
  const signed = (method: string, path: string, value?: unknown) =>
    app.request(callerKey.request(method, path, value, deps.clock(), callerId))
  return {
    deps,
    seed,
    callerId,
    targetId,
    principal,
    targetKey,
    results,
    app,
    signed,
    heartbeat: (value: object = beat) => signed('POST', R.hostHeartbeat, value),
  }
}
