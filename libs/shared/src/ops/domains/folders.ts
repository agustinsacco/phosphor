import { PAGED_LANE_OPS } from '../../host-protocol-paged-lanes'
import { caps, domain, id, ids, object, optional, path, previous, workspaceWrite } from './spec'

const read = domain('machine', caps('workspaces.read'))
const write = domain('machine', workspaceWrite)
const sandbox = { flag: 'sandboxes' } as const
const byPath = { positional: ['path'] } as const
export const folders = [
  read(PAGED_LANE_OPS.folders, 'List a page of folders.', 'read', undefined, {
    flag: 'pagedLanes',
  }),
  read(
    'folder.browse',
    'Browse folders on this machine.',
    'read',
    object({ path: optional(path) }),
    byPath,
  ),
  write('folder.add', 'Add an existing folder.', 'create', object({ path }), {
    ...byPath,
    inverse: previous('folder.remove'),
  }),
  write('folder.create', 'Create and add a folder.', 'create', object({ path }), {
    ...byPath,
    inverse: previous('folder.remove'),
  }),
  write('folder.order', 'Set the order of folders.', 'create', object({ ids }), {
    inverse: previous('folder.order'),
  }),
  write(
    'folder.remove',
    'Remove a folder from the machine’s list.',
    'destructive',
    object({ id }),
    { positional: ['id'] },
  ),
  read('sandbox.list', 'List sandboxes.', 'read', undefined, sandbox),
  write('sandbox.create', 'Create a sandbox.', 'create', object({ name: id }), {
    ...sandbox,
    positional: ['name'],
  }),
  write('sandbox.rename', 'Rename a sandbox.', 'persistence', object({ path, name: id }), {
    ...sandbox,
    positional: ['path', 'name'],
    job: true,
  }),
  write('sandbox.delete', 'Delete a sandbox.', 'destructive', object({ path }), {
    ...sandbox,
    ...byPath,
    job: true,
  }),
]
