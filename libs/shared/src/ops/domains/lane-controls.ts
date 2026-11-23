import { Type } from 'typebox'
import { isLaneMarker, LANE_MARKER_MAX_UNITS } from '../../host-protocol-lane-marks'
import { ALL_THINKING_LEVELS } from '../../thinking'
import {
  choice,
  configure,
  control,
  domain,
  id,
  laneScope,
  object,
  on,
  optional,
  previous,
  ref,
  reverse,
  text,
} from './spec'

const self = domain('self', control, { routable: false })
const marks = domain(laneScope, control)
const target = optional(ref)
const pr = object({ url: text(2048) })
const after = { applies: 'after-run' } as const
const next = { applies: 'next-request' } as const
export const laneControls = [
  self(
    'swarm.on',
    'Request Swarm for this lane unless the user turned it off.',
    'lane',
    undefined,
    { ...next, inverse: reverse('swarm.off') },
  ),
  self('swarm.off', 'Turn off Swarm for this lane.', 'lane', undefined, {
    ...next,
    inverse: reverse('swarm.on'),
  }),
  self('model.set', 'Switch the model after this run.', 'lane', object({ model: id }), {
    ...after,
    positional: ['model'],
    inverse: previous('model.set'),
  }),
  self(
    'thinking.set',
    'Set this lane’s thinking level.',
    'lane',
    object({ level: choice(...ALL_THINKING_LEVELS) }),
    { ...after, positional: ['level'], inverse: previous('thinking.set') },
  ),
  marks('lane.rename', 'Rename a lane.', 'lane', object({ name: text(200), ref: target }), {
    positional: ['name'],
    inverse: previous('lane.rename'),
  }),
  marks('lane.pin', 'Pin or unpin a lane.', 'lane', object({ on, ref: target }), {
    positional: ['on'],
    inverse: previous('lane.pin'),
  }),
  marks(
    'lane.marker',
    'Set a lane marker, or clear it with none.',
    'lane',
    object({ marker: Type.Refine(text(LANE_MARKER_MAX_UNITS), isLaneMarker), ref: target }),
    { positional: ['marker'], inverse: previous('lane.marker') },
  ),
  self('pr.track', 'Track a pull request in this lane.', 'lane', pr, {
    positional: ['url'],
    inverse: reverse('pr.clear'),
  }),
  self('pr.hide', 'Hide a tracked pull request.', 'lane', pr, {
    positional: ['url'],
    inverse: reverse('pr.clear'),
  }),
  self('pr.clear', 'Clear a pull request tracking override.', 'lane', pr, { positional: ['url'] }),
  self(
    'contextFiles.set',
    'Enable or disable context files in this lane.',
    'lane',
    object({ claude: optional(on), agents: optional(on) }, { minProperties: 1 }),
    { ...next, flag: 'laneContext', inverse: previous('contextFiles.set') },
  ),
  self(
    'lane.compact',
    'Compact this lane after the run.',
    'lane',
    object({ instructions: optional(text(4096)) }),
    { ...after, sensitive: ['instructions'] },
  ),
  ...['lane.autoCompaction', 'lane.autoRetry'].map((name) =>
    self(
      name,
      name === 'lane.autoRetry' ? 'Toggle automatic retry.' : 'Toggle automatic compaction.',
      'lane',
      object({ on }),
      { ...after, positional: ['on'], inverse: previous(name) },
    ),
  ),
  self(
    'lane.queueMode',
    'Change how queued inputs are consumed.',
    'lane',
    object({ queue: choice('steering', 'follow-up'), mode: choice('all', 'one-at-a-time') }),
    { ...after, positional: ['queue', 'mode'], inverse: previous('lane.queueMode') },
  ),
  self('lane.reload', 'Reload this lane after it settles.', 'lane', undefined, {
    applies: 'reload',
    flag: 'laneReload',
  }),
  self('notify', 'Show a notification in this lane.', 'lane', object({ text: text(200) }), {
    positional: ['text'],
    sensitive: ['text'],
  }),
  self(
    'mcp.lane',
    'Inspect or reconnect a server in this lane.',
    'lane',
    object({ server: id, action: choice('inspect', 'reconnect') }),
    { positional: ['server', 'action'], flag: 'laneContext', untrustedResult: true },
  ),
  self(
    'account.move',
    'Move this lane to an existing Claude account.',
    'configure',
    object({ accountId: id }),
    {
      positional: ['accountId'],
      applies: 'reload',
      requires: configure,
      inverse: previous('account.move'),
    },
  ),
]
