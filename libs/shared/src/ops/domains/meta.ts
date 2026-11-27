import { Type } from 'typebox'
import { isUuid } from '../../control-api'
import { parseAgentPolicy } from '../policy'
import {
  caps,
  configure,
  control,
  count,
  domain,
  id,
  object,
  optional,
  paged,
  ref,
  text,
  untrusted,
} from './spec'

const meta = domain('machine', caps('sessions.read'))
const surface = { surfaceOnly: true, routable: false } as const
const uuid = Type.Refine(text(36), isUuid)
const confirm = object({ confirmId: uuid })
const byConfirm = { positional: ['confirmId'] } as const
export const metaOps = [
  meta('help', 'Show operations or help for one topic.', 'read', object({ topic: optional(id) }), {
    scope: 'self',
    positional: ['topic'],
  }),
  meta('whoami', 'Identify the caller and its machine.', 'read', undefined, { scope: 'self' }),
  meta('policy.show', 'Read this machine’s agent policy.', 'read'),
  meta(
    'policy.set',
    'Change the agent policy as the user.',
    'never',
    object({ policy: Type.Refine(Type.Unknown(), (p) => parseAgentPolicy(p) !== null) }),
    { ...surface, requires: configure },
  ),
  meta(
    'audit.list',
    'List audited agent operations.',
    'read',
    object({ lane: optional(ref), limit: optional(count(100)) }),
    { ...untrusted, ...paged },
  ),
  meta('audit.undo', 'Undo an audited operation as the user.', 'never', object({ auditId: id }), {
    ...surface,
    positional: ['auditId'],
    requires: control,
  }),
  meta(
    'confirm.info',
    'Inspect one confirmation.',
    'read',
    object(
      { confirmId: optional(uuid), dialogId: optional(id) },
      { minProperties: 1, maxProperties: 1 },
    ),
    { ...surface, ...untrusted },
  ),
  meta('confirm.list', 'List pending confirmations for review.', 'read', undefined, {
    ...surface,
    ...untrusted,
  }),
  // Not surface-only: the dispatcher checks that the caller created this confirmation.
  meta(
    'confirm.status',
    'Read the status of a confirmation you created.',
    'read',
    confirm,
    byConfirm,
  ),
  meta('confirm.approve', 'Approve an exact pending action as the user.', 'never', confirm, {
    ...surface,
    ...byConfirm,
    requires: control,
  }),
  meta('confirm.deny', 'Deny a pending action as the user.', 'never', confirm, {
    ...surface,
    ...byConfirm,
    requires: control,
  }),
  meta(
    'job.status',
    'Read progress or the result of a background operation.',
    'read',
    object({ jobId: id }),
    { positional: ['jobId'], ...untrusted },
  ),
  meta('job.list', 'List background operations.', 'read', undefined, { ...untrusted, ...paged }),
]
