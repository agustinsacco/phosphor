import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import * as files from '../files'
import { loadGitStatus, parseGitStatus } from './status'

vi.mock('../files', { spy: true })

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(files, 'checkedPath').mockResolvedValue('/lane/file')
  vi.spyOn(files, 'safeGit').mockImplementation(async (_root, args) => {
    if (args[0] === 'status') return ' M sub/file\0'
    if (args[0] === 'symbolic-ref') return 'topic\n'
    if (args[0] === 'rev-parse') return 'upstream-object\n'
    if (args[0] === 'rev-list') return '2\t3\n'
    throw new Error(`Unexpected git arguments: ${args.join(' ')}`)
  })
})
afterEach(() => vi.restoreAllMocks())

describe('parseGitStatus', () => {
  it('uses a null-prototype map, preserves special names and overwrites duplicate paths', async () => {
    const result = await parseGitStatus('/lane', '', '?? __proto__\0 M file\0M  file\0\0')
    expect(Object.getPrototypeOf(result)).toBe(null)
    expect(result).toEqual({ ['__proto__']: '??', file: 'M ' })
    expect(await parseGitStatus('/lane', '', '')).toEqual({})
  })

  it('skips rename and copy sources without interpreting NUL-delimited whitespace', async () => {
    const result = await parseGitStatus(
      '/lane',
      'sub/',
      'R  sub/new name\0outside/old\0 C sub/line\nfile\0outside/source\0',
    )
    expect(result).toEqual({ 'new name': 'R ', 'line\nfile': ' C' })
    expect(vi.mocked(files.checkedPath).mock.calls).toEqual([
      ['/lane', 'new name', true],
      ['/lane', 'line\nfile', true],
    ])
  })

  it('rejects paths outside the prefix before authorization', async () => {
    await expect(parseGitStatus('/lane', 'sub/', ' M submarine/file\0')).rejects.toMatchObject({
      code: 'bad-request',
    })
    expect(files.checkedPath).not.toHaveBeenCalled()
  })

  it('propagates path authorization failures', async () => {
    vi.mocked(files.checkedPath).mockRejectedValue(new files.FileFailure('bad-request'))
    await expect(parseGitStatus('/lane', 'sub/', ' M sub/escape\0')).rejects.toMatchObject({
      code: 'bad-request',
    })
  })

  it('allows the entry limit, counting destinations rather than skipped rename sources', async () => {
    const raw = 'R  sub/file\0old\0'.repeat(FILE_LIMITS.entries)
    expect(await parseGitStatus('/lane', 'sub/', raw)).toEqual({ file: 'R ' })
    expect(files.checkedPath).toHaveBeenCalledTimes(FILE_LIMITS.entries)
    await expect(parseGitStatus('/lane', 'sub/', raw + ' M sub/extra\0')).rejects.toMatchObject({
      code: 'too-large',
    })
  })
})

describe('loadGitStatus', () => {
  it('loads porcelain and resolves the upstream before counting divergence', async () => {
    expect(await loadGitStatus('/lane', 'sub/')).toEqual({
      status: { file: ' M' },
      branch: 'topic',
      ahead: 2,
      behind: 3,
    })
    expect(vi.mocked(files.safeGit).mock.calls).toEqual([
      ['/lane', ['status', '--porcelain=v1', '-z', '-uall', '--', '.']],
      ['/lane', ['symbolic-ref', '--short', 'HEAD']],
      ['/lane', ['rev-parse', '--verify', '--end-of-options', '@{upstream}']],
      ['/lane', ['rev-list', '--left-right', '--count', 'HEAD...upstream-object']],
    ])
  })

  it('treats detached HEAD and missing upstream as normal', async () => {
    vi.mocked(files.safeGit).mockImplementation(async (_root, args) => {
      if (args[0] === 'status') return ''
      throw new Error('no symbolic branch or upstream')
    })
    expect(await loadGitStatus('/lane', '')).toEqual({
      status: {},
      branch: null,
      ahead: 0,
      behind: 0,
    })
    expect(files.safeGit).toHaveBeenCalledTimes(3)
  })

  it('stops before branch discovery when porcelain loading fails', async () => {
    const error = new Error('git failure')
    vi.mocked(files.safeGit).mockRejectedValue(error)
    await expect(loadGitStatus('/lane', '')).rejects.toBe(error)
    expect(files.safeGit).toHaveBeenCalledTimes(1)
  })

  it.each(['NaN 0', '0 -1', '0 1.5', '9007199254740992 0'])(
    'rejects invalid divergence counts: %s',
    async (counts) => {
      vi.mocked(files.safeGit)
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('HEAD')
        .mockResolvedValueOnce('upstream')
        .mockResolvedValueOnce(counts)
      await expect(loadGitStatus('/lane', '')).rejects.toMatchObject({ code: 'internal' })
    },
  )
})
