import { Type } from 'typebox'
import { ROUTINE_LIMITS } from '../../host-protocol-routines'
import {
  caps,
  choice,
  count,
  domain,
  id,
  object,
  on,
  optional,
  previous,
  reverse,
  text,
  untrusted,
} from './spec'

// The binding computes trust and starts new definitions paused. Neither field is an input.
const definition = object({
  name: text(100),
  instructions: text(32000),
  repositoryId: id,
  isolated: on,
  intent: choice('report', 'code'),
  provider: text(200),
  model: text(300),
  timezone: text(100),
  schedule: Type.Union([
    object({ kind: Type.Literal('manual') }),
    object({ kind: Type.Literal('once'), at: count(Number.MAX_SAFE_INTEGER) }),
    object({ kind: Type.Literal('cron'), expression: text(200) }),
  ]),
  period: choice('none', 'previous-day', 'previous-week'),
  catchUpHours: count(168, 0),
  maxRuntimeMinutes: count(240),
})
const routine = domain('machine', caps('routines'))
const guarded = caps('routines', 'sessions.control')
const byId = { positional: ['id'] } as const
const one = object({ id })
export const routines = [
  routine('routine.list', 'List routines.', 'read', undefined, untrusted),
  routine(
    'routine.history',
    'List recent routine runs.',
    'read',
    object({ id: optional(id), offset: optional(count(ROUTINE_LIMITS.offset, 0)) }),
    untrusted,
  ),
  routine(
    'routine.activity',
    'List routine activity.',
    'read',
    object({ id: optional(id) }),
    untrusted,
  ),
  routine('routine.check', 'Check whether a routine can run.', 'read', object({ definition }), {
    sensitive: ['definition'],
  }),
  routine(
    'routine.create',
    'Save a paused routine for review.',
    'persistence',
    object({ definition }),
    { sensitive: ['definition'], inverse: previous('routine.archive') },
  ),
  routine(
    'routine.fromLane',
    'Promote a routine run to a lane.',
    'persistence',
    object({ runId: id }),
    { positional: ['runId'] },
  ),
  routine(
    'routine.edit',
    'Edit a routine at its current revision.',
    'persistence',
    object({
      id,
      patch: Type.Partial(definition, { additionalProperties: false, minProperties: 1 }),
      revision: count(Number.MAX_SAFE_INTEGER, 0),
    }),
    { ...byId, sensitive: ['patch'], requires: guarded, inverse: previous('routine.edit') },
  ),
  routine('routine.enable', 'Enable a previously trusted routine.', 'persistence', one, {
    ...byId,
    requires: guarded,
    inverse: reverse('routine.disable'),
  }),
  routine('routine.disable', 'Pause a routine.', 'persistence', one, {
    ...byId,
    inverse: reverse('routine.enable'),
  }),
  routine('routine.run', 'Run a trusted routine now.', 'create', one, {
    ...byId,
    requires: guarded,
  }),
  routine('routine.cancel', 'Cancel a routine run.', 'create', object({ runId: id }), {
    positional: ['runId'],
  }),
  routine('routine.skipNext', 'Skip the next scheduled run.', 'persistence', one, byId),
  routine('routine.pauseAll', 'Pause all routines on this machine.', 'persistence'),
  routine('routine.archive', 'Archive a routine.', 'persistence', one, byId),
  routine('routine.delete', 'Delete a routine permanently.', 'destructive', one, {
    ...byId,
    requires: guarded,
  }),
]
