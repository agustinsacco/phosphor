import type { Hono } from 'hono'
import {
  CONTROL_ROUTES,
  isUuid,
  parseMachinesResponse,
  parseMachineRenameRequest,
  parseEnrollmentApproveResponse,
} from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import { userGuard, type createUserAuth } from '../auth/user'
import { ControlFailure, type Env } from '../http'
import { body, outcome, parsed, record } from './shared'

export function machines(app: Hono<Env>, deps: AppDeps, auth: ReturnType<typeof createUserAuth>) {
  const guard = userGuard(auth, deps.supabase)
  app.get(CONTROL_ROUTES.machines, guard, async (c) =>
    c.json(
      parsed(
        parseMachinesResponse(
          await deps.supabase.rpc('control_machines', { p_user_id: c.get('user').userId }),
        ),
      ),
    ),
  )
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
      return input ? c.json(parsed(parseEnrollmentApproveResponse(value))) : c.body(null, 204)
    })
  }
}
