import { Type } from 'typebox'
import {
  caps,
  choice,
  configure,
  control,
  count,
  domain,
  object,
  path,
  ref,
  text,
  optional,
  paged,
  untrusted,
} from './spec'

const read = domain('machine', caps('sessions.read'), untrusted)
const machine = domain('machine', configure)
const inventory = domain('machine', caps('skills.read'), untrusted)
const lane = domain('self', control, { routable: false, ...untrusted })
const service = { class: 'service' } as const
const query = object({ query: text(2000), limit: optional(count(20)) })
/** One move: a query, a name to expand (with context names), or a route from one name to another. */
const search = object({
  query: optional(text(2000)),
  from: optional(text(200)),
  to: optional(text(200)),
  context: optional(Type.Array(text(200), { maxItems: 5 })),
  limit: optional(count(20)),
})
export const machineOps = [
  read('machine.status', 'Show machine and Phosphor service status.', 'read'),
  read('machine.doctor', 'Show cached machine and Phosphor service health.', 'read'),
  machine(
    'machine.refreshEnvironment',
    'Refresh the login-shell environment for new lanes.',
    'configure',
  ),
  inventory(
    'machine.models',
    'List available models.',
    'read',
    object({ provider: optional(text(200)) }),
    paged,
  ),
  inventory('machine.providers', 'List available providers.', 'read', undefined, paged),
  inventory(
    'machine.commands',
    'List available commands.',
    'read',
    object({ project: optional(path) }),
    paged,
  ),
  inventory('machine.usage', 'Read provider usage.', 'read'),
  machine(
    'service.update',
    'Pause lanes and update the Phosphor service.',
    'destructive',
    undefined,
    { job: true, deadlineMs: 600_000 },
  ),
  machine(
    'service.pause',
    'Stop working turns or cancel a pending service update.',
    'never',
    object({ action: choice('abort-now', 'cancel') }),
    { surfaceOnly: true, routable: false },
  ),
  machine('maintenance.scan', 'Scan for cleanup candidates.', 'read'),
  machine('maintenance.run', 'Run destructive workspace cleanup.', 'destructive'),
  read('hosts.list', 'List machines available to this lane.', 'read', undefined, {
    routable: false,
  }),
  lane('brain.search', 'Search Brain for relevant memories.', 'read', search, {
    ...service,
    positional: ['query'],
    requires: caps('sessions.read'),
    sensitive: ['query', 'from', 'to', 'context'],
  }),
  lane(
    'brain.flag',
    'Flag a memory from this lane’s latest briefing.',
    'lane',
    object({
      ref: count(20),
      problem: choice('wrong', 'outdated', 'duplicate'),
      reason: text(300),
    }),
    { ...service, positional: ['ref', 'problem', 'reason'], sensitive: ['reason'] },
  ),
  read('brain.status', 'Show Brain indexing status.', 'read', undefined, paged),
  read('brain.find', 'Find matching entries in Brain.', 'read', query, {
    positional: ['query'],
    sensitive: ['query'],
  }),
  machine('brain.queue', 'Queue a lane for Brain indexing.', 'lane', object({ lane: ref }), {
    positional: ['lane'],
  }),
  lane('ui.open', 'Suggest a Phosphor view to open.', 'lane', object({ target: ref }), {
    positional: ['target'],
  }),
]
