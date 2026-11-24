import type { Context, Hono, MiddlewareHandler } from 'hono'
import {
  CONTROL_ROUTES,
  isUuid,
  machineReachRoute,
  parseMachinesResponse,
  parseMachineRenameRequest,
  parseMachineReachRequest,
  parseMachineReachResponse,
  parseEnrollmentApproveResponse,
} from '@phosphor/shared/control-api'
import type { TraceEvents } from '../events'
import type { AppDeps } from '../app'
import { userGuard, type createUserAuth } from '../auth/user'
import { ControlFailure, type Env } from '../http'
import { body, outcome, parsed, record } from './shared'

interface ReachFlags {
  readonly machineReach: boolean
  readonly machineGrants: boolean
}

/** `control_machine_reach_list` by machine id; null when the answer is not usable. */
export function parseReachList(value: unknown): ReadonlyMap<string, ReachFlags> | null {
  if (!Array.isArray(value)) return null
  const flags = new Map<string, ReachFlags>()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const { id, machineReach, machineGrants } = entry as Record<string, unknown>
    if (!isUuid(id) || typeof machineReach !== 'boolean' || typeof machineGrants !== 'boolean')
      return null
    flags.set(id, { machineReach, machineGrants })
  }
  return flags
}

/**
 * The machine list never depends on the reach lookup: when it fails the machines go out
 * without reach fields, which a surface reads as old control and hides the switch.
 */
async function reachFlags(
  c: Context<Env>,
  deps: AppDeps,
  events: TraceEvents,
): Promise<ReadonlyMap<string, ReachFlags> | null> {
  const userId = c.get('user').userId
  let flags: ReadonlyMap<string, ReachFlags> | null
  try {
    flags = parseReachList(
      await deps.supabase.rpc('control_machine_reach_list', { p_user: userId }),
    )
  } catch {
    flags = null
  }
  if (!flags) events.emit(c, 'machines.reach_unavailable', { userId })
  return flags
}

/** The owner's per-machine reach switch. Off revokes the machine's principal. */
function machineReach(
  app: Hono<Env>,
  deps: AppDeps,
  guard: MiddlewareHandler<Env>,
  events: TraceEvents,
) {
  app.patch(machineReachRoute(':id'), guard, async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) throw new ControlFailure('bad-request')
    const input = parsed(parseMachineReachRequest(body(c)), 'bad-request')
    const userId = c.get('user').userId
    const value = record(
      await deps.supabase.rpc('control_machine_reach_set', {
        p_user: userId,
        p_host: id,
        p_enabled: input.enabled,
      }),
    )
    outcome(value, 'set')
    const result = parsed(parseMachineReachResponse(value))
    events.emit(c, 'machine.reach', { userId, hostId: id, machineReach: result.machineReach })
    return c.json(result)
  })
}

export function machines(
  app: Hono<Env>,
  deps: AppDeps,
  auth: ReturnType<typeof createUserAuth>,
  events: TraceEvents,
) {
  const guard = userGuard(auth, deps.supabase)
  app.get(CONTROL_ROUTES.machines, guard, async (c) => {
    const listed = parsed(
      parseMachinesResponse(
        await deps.supabase.rpc('control_machines', { p_user_id: c.get('user').userId }),
      ),
    )
    const flags = await reachFlags(c, deps, events)
    if (!flags) return c.json(listed)
    return c.json({
      ...listed,
      machines: listed.machines.map((machine) => ({ ...machine, ...flags.get(machine.id) })),
    })
  })
  for (const method of ['PATCH', 'DELETE']) {
    app.on(method, CONTROL_ROUTES.machines + '/:id', guard, async (c) => {
      const id = c.req.param('id')
      if (!isUuid(id)) throw new ControlFailure('bad-request')
      const input =
        method === 'PATCH' ? parsed(parseMachineRenameRequest(body(c)), 'bad-request') : null
      const value = record(
        await deps.supabase.rpc(
          method === 'PATCH' ? 'control_machine_rename' : 'control_machine_revoke',
          {
            p_user_id: c.get('user').userId,
            p_host_id: id,
            ...(input ? { p_label: input.label } : {}),
          },
        ),
      )
      outcome(value, method === 'PATCH' ? 'renamed' : 'revoked')
      if (!input) events.removed(c, id, c.get('user').userId)
      return input ? c.json(parsed(parseEnrollmentApproveResponse(value))) : c.body(null, 204)
    })
  }
  machineReach(app, deps, guard, events)
}
