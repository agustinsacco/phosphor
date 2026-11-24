import { Type } from 'typebox'
import {
  caps,
  choice,
  content,
  domain,
  id,
  ids,
  laneScope,
  object,
  on,
  optional,
  path,
  previous,
  ref,
  text,
  untrusted,
  workspaceWrite,
} from './spec'

const target = ref
const at = object({ target })
const file = object({ target, path })
const atRevision = object({ target, ref: id, path })
const read = domain(laneScope, caps('workspaces.read'), untrusted)
const write = domain(laneScope, workspaceWrite)
const positionalPath = { positional: ['path'] } as const
const worktree = domain('machine', workspaceWrite)

export const workspace = [
  read('files.list', 'List files at a workspace path.', 'read', file, positionalPath),
  read('files.read', 'Read a workspace file.', 'read', file, positionalPath),
  read('files.search', 'Search workspace files.', 'read', object({ target, query: text(2000) }), {
    positional: ['query'],
  }),
  write(
    'files.write',
    'Replace a file body at its expected revision.',
    'lane',
    object({ target, path, content, expected: Type.Union([id, Type.Null()]) }),
    { ...positionalPath, sensitive: ['content'] },
  ),
  write('files.create', 'Create a workspace file.', 'lane', object({ target, path, content }), {
    ...positionalPath,
    sensitive: ['content'],
  }),
  // Host binding: files.create {kind:'directory'} and files.delete (moves to Trash).
  write('files.mkdir', 'Create a directory.', 'lane', file, positionalPath),
  write('files.trash', 'Move a file to the trash.', 'lane', file, {
    ...positionalPath,
    inverse: previous('files.rename'),
  }),
  write(
    'files.rename',
    'Rename a workspace path.',
    'lane',
    object({ target, from: path, to: path }),
    {
      positional: ['from', 'to'],
      inverse: ({ target, from, to }) => ({
        op: 'files.rename',
        args: { target, from: to, to: from },
      }),
    },
  ),
  write(
    'files.transfer',
    'Copy or move a file into a directory.',
    'lane',
    object({ target, source: path, directory: path, mode: choice('copy', 'move') }),
    { positional: ['source', 'directory', 'mode'] },
  ),
  read('git.info', 'Show the checkout and branch.', 'read', at),
  read('git.status', 'List working tree changes.', 'read', at),
  read('git.diff', 'Read the working tree diff.', 'read', object({ target, path: optional(path) })),
  read('git.show', 'Read a file at a revision.', 'read', atRevision, {
    positional: ['ref', 'path'],
  }),
  read('git.branches', 'List branches.', 'read', at),
  read('git.worktrees', 'List worktrees.', 'read', at),
  write('git.fetch', 'Fetch remote references.', 'lane', object({ target, force: optional(on) })),
  write('git.pull', 'Fast-forward the current checkout.', 'lane', at),
  write(
    'git.updateFromMain',
    'Merge the main branch into the worktree.',
    'lane',
    object({ target, mainBranch: id }),
  ),
  write(
    'git.commitAll',
    'Commit changes in the checkout.',
    'lane',
    object({ target, message: text(4096) }),
    { positional: ['message'], sensitive: ['message'] },
  ),
  write('git.checkout', 'Check out a branch.', 'lane', object({ target, branch: id }), {
    positional: ['branch'],
  }),
  write('git.renameBranch', 'Rename a branch.', 'lane', object({ target, from: id, to: id }), {
    positional: ['from', 'to'],
  }),
  write('git.restoreFile', 'Restore a file from a revision.', 'lane', atRevision, {
    positional: ['ref', 'path'],
  }),
  write('git.merge', 'Merge a branch.', 'configure', object({ target, branch: id }), {
    positional: ['branch'],
  }),
  ...(['worktree.add', 'worktree.restore', 'worktree.recreate'] as const).map((name) =>
    worktree(
      name,
      {
        'worktree.add': 'Add a worktree.',
        'worktree.restore': 'Restore a worktree.',
        'worktree.recreate': 'Recreate a missing worktree.',
      }[name],
      'create',
      object({ repo: path, name: id, branch: id }),
      { positional: ['repo', 'name', 'branch'], inverse: previous('worktree.remove') },
    ),
  ),
  worktree(
    'worktree.remove',
    'Remove a worktree and optionally delete its branch.',
    'destructive',
    object({ path, force: optional(on), deleteBranch: optional(on) }),
    positionalPath,
  ),
  worktree(
    'worktree.prune',
    'Prune stale worktree registrations.',
    'destructive',
    object({ path }),
    positionalPath,
  ),
  read('pr.list', 'List pull requests for a repository.', 'read', at),
  read(
    'pr.status',
    'Read the status of selected pull requests.',
    'read',
    object({ target, refs: ids }),
  ),
  read('pr.detail', 'Read pull request checks and discussion.', 'read', object({ target, ref }), {
    positional: ['ref'],
  }),
]
