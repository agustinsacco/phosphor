import { expect, it } from 'vitest'
import { parseClientFrame } from './host-protocol'
import {
  parseFolderParams,
  parseFolderList,
  parseRepositoryOp,
  parseDeleteLaneOp,
  parseDeleteLaneResult,
} from './host-protocol-repositories'
const laneId = '12345678-1234-4234-8234-123456789abc'
it('strictly bounds relative paths and exact folder params', () => {
  expect(parseFolderParams({})).toEqual({})
  expect(parseFolderParams({ path: '' })).toEqual({ path: '' })
  expect(parseFolderParams({ path: 'x'.repeat(4096) })).not.toBeNull()
  expect(parseFolderParams({ path: '.config/app' })).toEqual({ path: '.config/app' })
  expect(parseFolderParams({ path: 'x', hidden: true })).toEqual({ path: 'x', hidden: true })
  expect(parseFolderParams({ hidden: false })).toEqual({})
  expect(parseFolderParams({ hidden: 'yes' })).toBeNull()
  for (const path of [
    '/absolute',
    '../escape',
    '.',
    'x/./y',
    'x/../y',
    'x//y',
    'a\\b',
    'a\0b',
    'x'.repeat(4097),
  ])
    expect(parseFolderParams({ path })).toBeNull()
  expect(parseFolderParams({ path: 'Projects/repo', extra: 1 })).toBeNull()
  expect(
    parseFolderList({
      path: '',
      truncated: false,
      entries: [{ name: 'src', isRepository: true, configured: false }],
    }),
  ).not.toBeNull()
  expect(
    parseFolderList({
      path: '',
      truncated: false,
      entries: Array(501).fill({ name: 'src', isRepository: false, configured: false }),
    }),
  ).toBeNull()
  expect(
    parseFolderList({
      path: '',
      truncated: false,
      entries: [{ name: '../x', isRepository: false, configured: false }],
    }),
  ).toBeNull()
  for (const name of ['..', '.'])
    expect(
      parseFolderList({
        path: '',
        truncated: false,
        entries: [{ name, isRepository: false, configured: false }],
      }),
    ).toBeNull()
})
it('admits creating exactly one named folder', () => {
  const create = (path: unknown) =>
    parseRepositoryOp({ type: 'host.repositories.createFolder', path })
  for (const path of ['new', 'Projects/new', '.config/.app'])
    expect(create(path)).toEqual({ type: 'host.repositories.createFolder', path })
  for (const path of ['', '/abs', 'x/..', 'x/.', 'x//y', 'a\\b', `x/${'n'.repeat(256)}`, 1])
    expect(create(path)).toBeNull()
  expect(
    parseRepositoryOp({ type: 'host.repositories.createFolder', path: 'x', extra: 1 }),
  ).toBeNull()
  expect(
    parseClientFrame(
      JSON.stringify({
        type: 'command',
        requestId: laneId,
        op: { type: 'host.repositories.createFolder', path: 'Projects/new' },
      }),
    ).ok,
  ).toBe(true)
})
it('admits exact repository mutations and fenced deletion shapes', () => {
  expect(parseRepositoryOp({ type: 'host.repositories.add', path: 'Projects' })).not.toBeNull()
  expect(
    parseRepositoryOp({ type: 'host.repositories.remove', repositoryId: '1234567890abcdef' }),
  ).not.toBeNull()
  expect(parseRepositoryOp({ type: 'host.repositories.remove', repositoryId: 'bad' })).toBeNull()
  const op = { type: 'lane.delete', laneId, removeWorktree: true, removeBranch: true }
  expect(parseDeleteLaneOp(op)).toEqual(op)
  for (const extra of [{ extra: true }, { removeBranch: 1 }, { laneId: 'bad' }])
    expect(parseDeleteLaneOp({ ...op, ...extra })).toBeNull()
  expect(
    parseClientFrame(JSON.stringify({ type: 'command', requestId: laneId, laneId, fence: 1, op }))
      .ok,
  ).toBe(true)
  expect(
    parseClientFrame(
      JSON.stringify({
        type: 'command',
        requestId: laneId,
        laneId,
        op: { type: 'host.repositories.add', path: 'Projects' },
      }),
    ).ok,
  ).toBe(false)
})

it('strictly parses confirmed branch retention, never guesses a missing result', () => {
  for (const branchKept of [true, false])
    expect(parseDeleteLaneResult({ branchKept })).toEqual({ branchKept })
  for (const result of [null, {}, { branchKept: 1 }, { branchKept: false, extra: true }])
    expect(parseDeleteLaneResult(result)).toBeNull()
})
