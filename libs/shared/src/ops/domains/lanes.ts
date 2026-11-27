import { Type } from 'typebox'
import { PAGED_LANE_OPS } from '../../host-protocol-paged-lanes'
import { ALL_THINKING_LEVELS } from '../../thinking'
import {
  caps,
  choice,
  control,
  count,
  domain,
  id,
  ids,
  laneOrAsk,
  laneScope,
  object,
  on,
  optional,
  previous,
  ref,
  reverse,
  text,
  untrusted,
  workspaceWrite,
} from './spec'

const read = domain('machine', caps('sessions.read'), untrusted)
const lane = domain('other-lane', control)
const target = object({ ref })
const byRef = { positional: ['ref'] } as const
const editing = { flag: 'laneEditing' } as const
const filter = { folder: optional(ref), state: optional(id) }
const archive = domain('machine', workspaceWrite)
const artifact = domain(
  (a) => (a.lane === undefined ? 'machine' : 'other-lane'),
  caps('artifacts.read'),
  untrusted,
)
export const lanes = [
  read(PAGED_LANE_OPS.lanes, 'List a page of lanes.', 'read', object(filter), {
    flag: 'pagedLanes',
  }),
  read(
    'lane.search',
    'Find lanes matching a query.',
    'read',
    object({ ...filter, q: text(2000) }),
    { positional: ['q'] },
  ),
  read(
    'lane.read',
    'Read a lane summary, messages, artifacts, pull requests or diagnostics.',
    'read',
    object({
      ref,
      part: optional(choice('summary', 'messages', 'artifacts', 'prs', 'debug')),
      messages: optional(count(50)),
    }),
    { ...byRef, scope: 'other-lane' },
  ),
  read('lane.tree', 'Read the conversation tree for a lane.', 'read', target, {
    ...byRef,
    ...editing,
    scope: 'other-lane',
  }),
  lane(
    'lane.create',
    'Start a lane, optionally with an initial prompt. --folder takes a registered folder name, path or ID; --model takes provider/id, for example pi-claude-cli/claude-opus-5-5. Without --prompt the lane starts idle.',
    'create',
    object({
      folder: ref,
      worktree: optional(id),
      fresh: optional(on),
      name: optional(id),
      model: optional(id),
      thinking: optional(choice(...ALL_THINKING_LEVELS)),
      prompt: optional(text(32000)),
    }),
    { scope: 'machine', sensitive: ['prompt'], inverse: previous('lane.archive') },
  ),
  ...['lane.fork', 'lane.clone'].map((name) =>
    lane(
      name,
      name === 'lane.fork' ? 'Fork a lane at an entry.' : 'Clone a lane conversation.',
      'create',
      object({ ref, at: optional(id) }),
      { ...byRef, ...editing, inverse: previous('lane.archive') },
    ),
  ),
  lane('lane.resume', 'Resume a stopped lane.', 'create', target, {
    ...byRef,
    inverse: reverse('lane.stop'),
  }),
  lane('lane.stop', 'Stop a lane.', laneOrAsk, target, {
    ...byRef,
    scope: laneScope,
    applies: 'after-run',
    inverse: reverse('lane.resume'),
  }),
  lane('lane.archive', 'Archive a lane.', laneOrAsk, target, {
    ...byRef,
    scope: laneScope,
    applies: 'after-run',
    requires: workspaceWrite,
    inverse: previous('archive.restore'),
  }),
  lane(
    'lane.delete',
    'Delete a lane and its selected worktree or branch.',
    'destructive',
    object({ ref, removeWorktree: optional(on), removeBranch: optional(on) }),
    { ...byRef, scope: laneScope, requires: workspaceWrite },
  ),
  lane(
    'lane.label',
    'Label a conversation entry.',
    'lane',
    object({ ref, entry: id, label: optional(text(200)) }),
    {
      ...editing,
      positional: ['ref', 'entry', 'label'],
      scope: laneScope,
      inverse: previous('lane.label'),
    },
  ),
  ...['lane.jump', 'lane.rewind'].map((name) =>
    lane(
      name,
      name === 'lane.jump' ? 'Switch to a conversation entry.' : 'Rewind a lane to an entry.',
      laneOrAsk,
      object({ ref, entry: id }),
      {
        ...editing,
        positional: ['ref', 'entry'],
        scope: laneScope,
        inverse: previous('lane.jump'),
      },
    ),
  ),
  lane('lane.move', 'Move a lane to another machine.', 'create', object({ ref, to: id }), {
    positional: ['ref', 'to'],
  }),
  read('lane.export', 'Export a lane conversation.', 'read', target, {
    ...byRef,
    scope: 'other-lane',
  }),
  lane('lane.markRead', 'Mark a lane as read.', 'lane', target, byRef),
  read(
    'archive.list',
    'List archived lanes and optionally measure their size.',
    'read',
    object({ measure: optional(on) }),
  ),
  archive('archive.restore', 'Restore an archived lane.', 'create', object({ id }), {
    positional: ['id'],
    inverse: previous('lane.archive'),
  }),
  archive(
    'archive.purge',
    'Permanently purge the selected archives.',
    'destructive',
    object(
      { ids: optional(ids), all: optional(Type.Literal(true)), removeWorktree: optional(on) },
      { oneOf: [{ required: ['ids'] }, { required: ['all'] }] },
    ),
    { job: true },
  ),
  artifact(
    'artifact.list',
    'List artifacts on this machine or in a lane.',
    'read',
    object({ lane: optional(ref) }),
  ),
  artifact(
    'artifact.read',
    'Read an artifact or one of its versions.',
    'read',
    object({ key: ref, lane: optional(ref), version: optional(count(Number.MAX_SAFE_INTEGER)) }),
    { positional: ['key'] },
  ),
  artifact('artifact.remove', 'Delete an artifact.', 'destructive', object({ key: ref }), {
    positional: ['key'],
    requires: caps('artifacts.read', 'sessions.control'),
  }),
]
