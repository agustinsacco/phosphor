import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import type { FeatureContext } from './feature'
import * as files from './files'
import { createGitFeature } from './git'

vi.mock('./files', { spy: true })

const laneId = '12345678-1234-4123-8123-123456789abc'
const root = '/lane'
const context: FeatureContext = {
  store: { getLane: () => null, listRepositories: () => [] },
  env: {},
  home: '/',
  log: vi.fn(),
}
const errors = {
  'bad-request': { ok: false, error: { code: 'bad-request', message: 'Invalid file request.' } },
  internal: { ok: false, error: { code: 'internal', message: 'File query failed.' } },
  'too-large': { ok: false, error: { code: 'too-large', message: 'Result exceeds the limit.' } },
}
let raw: string, prefix: string, branch: string | Error, upstream: string | Error, counts: string
let listing: string, size: string, content: string

beforeEach(() => {
  vi.clearAllMocks()
  raw = ''
  prefix = 'sub/'
  branch = 'topic\n'
  upstream = new Error('no upstream')
  counts = '2\t3\n'
  listing = '100644 blob object\tsub/file\0'
  size = '4\n'
  content = 'old\n'
  vi.spyOn(files, 'laneRoot').mockResolvedValue(root)
  vi.spyOn(files, 'listedPaths').mockResolvedValue([])
  vi.spyOn(files, 'checkedPath').mockResolvedValue(`${root}/file`)
  vi.spyOn(files, 'safeGit').mockImplementation(async (_root, args) => {
    if (args[0] === 'status') return raw
    if (args.includes('--show-prefix')) return prefix
    if (args[0] === 'symbolic-ref') {
      if (branch instanceof Error) throw branch
      return branch
    }
    if (args.includes('@{upstream}')) {
      if (upstream instanceof Error) throw upstream
      return upstream
    }
    if (args[0] === 'rev-list') return counts
    if (args[0] === 'rev-parse') return 'tree\n'
    if (args[0] === 'ls-tree') return listing
    if (args[1] === '-s') return size
    if (args[1] === 'blob') return content
    throw new Error(`Unexpected git arguments: ${args.join(' ')}`)
  })
})
afterEach(() => vi.restoreAllMocks())

const status = () => createGitFeature(context).call('git.status', { laneId })
const show = () => createGitFeature(context).call('git.show', { laneId, path: 'file', ref: 'HEAD' })

describe('git public contract characterization', () => {
  it('parses NUL-separated rename/copy destinations, skips sources and strips the lane prefix', async () => {
    raw = 'R  sub/new name\0outside/old\0 C sub/copy\0outside/source\0?? sub/line\nfile\0'
    expect(await status()).toEqual({
      ok: true,
      data: {
        status: { 'new name': 'R ', copy: ' C', 'line\nfile': '??' },
        branch: 'topic',
        ahead: 0,
        behind: 0,
      },
    })
    expect(files.checkedPath).toHaveBeenCalledTimes(3)
    expect(files.checkedPath).toHaveBeenCalledWith(root, 'new name', true)
    expect(files.safeGit).toHaveBeenCalledWith(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '-uall',
      '--',
      '.',
    ])
  })

  it.each(['outside/file', 'submarine/file'])(
    'rejects status outside the exact prefix: %s',
    async (path) => {
      raw = ` M ${path}\0`
      expect(await status()).toEqual(errors['bad-request'])
      expect(files.checkedPath).not.toHaveBeenCalled()
      expect(context.log).toHaveBeenLastCalledWith('feature-query', {
        laneId,
        method: 'git.status',
        reason: 'bad-request',
      })
    },
  )

  it('preserves checkedPath authorization failures', async () => {
    raw = ' M sub/escape\0'
    vi.mocked(files.checkedPath).mockRejectedValue(new files.FileFailure('bad-request'))
    expect(await status()).toEqual(errors['bad-request'])
  })

  it.each([new Error('detached'), 'HEAD\n'])(
    'treats detached HEAD and no upstream as normal: %s',
    async (value) => {
      branch = value
      expect(await status()).toEqual({
        ok: true,
        data: { status: {}, branch: null, ahead: 0, behind: 0 },
      })
      expect(vi.mocked(files.safeGit).mock.calls.some(([, args]) => args[0] === 'rev-list')).toBe(
        false,
      )
    },
  )

  it('uses the resolved upstream object for ahead/behind counts', async () => {
    upstream = 'abc123\n'
    expect(await status()).toEqual({
      ok: true,
      data: { status: {}, branch: 'topic', ahead: 2, behind: 3 },
    })
    expect(files.safeGit).toHaveBeenCalledWith(root, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      '@{upstream}',
    ])
    expect(files.safeGit).toHaveBeenCalledWith(root, [
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...abc123',
    ])
  })

  it.each(['NaN 1', '-1 0', '0 -1', '1.5 0', '9007199254740992 0'])(
    'rejects invalid ahead/behind counts with a fixed error: %s',
    async (value) => {
      upstream = 'abc123'
      counts = value
      expect(await status()).toEqual(errors.internal)
    },
  )

  it('resolves an exact prefixed tree entry and checks size before bounded blob content', async () => {
    listing = '100644 blob wrong\tsub/file-other\0' + listing
    expect(await show()).toEqual({ ok: true, data: { binary: false, size: 4, content: 'old\n' } })
    expect(files.safeGit).toHaveBeenCalledWith(root, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      'HEAD^{tree}',
    ])
    expect(files.safeGit).toHaveBeenCalledWith(root, [
      'ls-tree',
      '--full-tree',
      '-z',
      'tree',
      '--',
      'sub/file',
    ])
    const calls = vi.mocked(files.safeGit).mock.calls.map(([, args]) => args)
    expect(calls.slice(-2)).toEqual([
      ['cat-file', '-s', 'object'],
      ['cat-file', 'blob', 'object'],
    ])
    expect(files.safeGit).toHaveBeenLastCalledWith(
      root,
      ['cat-file', 'blob', 'object'],
      FILE_LIMITS.textBytes,
    )
    expect(files.listedPaths).not.toHaveBeenCalled()
  })

  it.each([
    '',
    '120000 blob object\tsub/file\0',
    '040000 tree object\tsub/file\0',
    '160000 commit object\tsub/file\0',
  ])('rejects absent or non-regular tree entries with a fixed error: %s', async (value) => {
    listing = value
    expect(await show()).toEqual(errors['bad-request'])
    expect(vi.mocked(files.safeGit).mock.calls.some(([, args]) => args[0] === 'cat-file')).toBe(
      false,
    )
  })

  it.each(['NaN', '-1', '1.5', '9007199254740992'])(
    'rejects invalid blob sizes before reading with a fixed error: %s',
    async (value) => {
      size = value
      expect(await show()).toEqual(errors.internal)
      expect(vi.mocked(files.safeGit).mock.calls.some(([, args]) => args[1] === 'blob')).toBe(false)
    },
  )

  it('rejects oversized blobs before reading with a fixed error', async () => {
    size = String(FILE_LIMITS.textBytes + 1)
    expect(await show()).toEqual(errors['too-large'])
    expect(vi.mocked(files.safeGit).mock.calls.some(([, args]) => args[1] === 'blob')).toBe(false)
  })

  it('converts unexpected subprocess failures to the fixed internal error', async () => {
    vi.mocked(files.safeGit).mockRejectedValue(new Error('private subprocess detail'))
    expect(await show()).toEqual(errors.internal)
  })
})
