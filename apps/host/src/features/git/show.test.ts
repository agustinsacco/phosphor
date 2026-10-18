import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import * as files from '../files'
import { readGitObject } from './show'

vi.mock('../files', { spy: true })

let listing: string, size: string, content: string
beforeEach(() => {
  vi.clearAllMocks()
  listing = '100644 blob object\tsub/file\0'
  size = '4\n'
  content = 'old\n'
  vi.spyOn(files, 'safeGit').mockImplementation(async (_root, args) => {
    if (args[0] === 'rev-parse') return 'tree\n'
    if (args[0] === 'ls-tree') return listing
    if (args[1] === '-s') return size
    if (args[1] === 'blob') return content
    throw new Error(`Unexpected git arguments: ${args.join(' ')}`)
  })
})
afterEach(() => vi.restoreAllMocks())

const show = () => readGitObject('/lane', 'sub/', 'file', 'HEAD')
const blobReads = () => vi.mocked(files.safeGit).mock.calls.filter(([, args]) => args[1] === 'blob')

describe('readGitObject', () => {
  it.each(['100644', '100755'])(
    'reads a regular blob in mode %s using argv and bounded content',
    async (mode) => {
      listing = `100644 blob other\tsub/file-other\0${mode} blob object\tsub/file\0`
      expect(await show()).toEqual({ binary: false, size: 4, content: 'old\n' })
      expect(vi.mocked(files.safeGit).mock.calls).toEqual([
        ['/lane', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{tree}']],
        ['/lane', ['ls-tree', '--full-tree', '-z', 'tree', '--', 'sub/file']],
        ['/lane', ['cat-file', '-s', 'object']],
        ['/lane', ['cat-file', 'blob', 'object'], FILE_LIMITS.textBytes],
      ])
    },
  )

  it('requires both path and ref before subprocess work', async () => {
    await expect(readGitObject('/lane', '')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(readGitObject('/lane', '', 'file')).rejects.toMatchObject({ code: 'bad-request' })
    expect(files.safeGit).not.toHaveBeenCalled()
  })

  it.each([
    '',
    '100644 blob object\tsub/file-other\0',
    '120000 blob object\tsub/file\0',
    '040000 tree object\tsub/file\0',
    '160000 commit object\tsub/file\0',
    '100644 blob\tsub/file\0',
  ])('refuses missing, inexact, non-regular or malformed tree entries: %s', async (entry) => {
    listing = entry
    await expect(show()).rejects.toMatchObject({ code: 'bad-request' })
    expect(files.safeGit).toHaveBeenCalledTimes(2)
  })

  it.each(['NaN', '-1', '1.5', '9007199254740992'])(
    'rejects an invalid object size before content: %s',
    async (value) => {
      size = value
      await expect(show()).rejects.toMatchObject({ code: 'internal' })
      expect(blobReads()).toHaveLength(0)
    },
  )

  it('allows exactly the text byte limit and refuses larger blobs before content', async () => {
    size = String(FILE_LIMITS.textBytes)
    content = 'x'.repeat(FILE_LIMITS.textBytes)
    expect(await show()).toEqual({ binary: false, size: FILE_LIMITS.textBytes, content })
    vi.clearAllMocks()
    size = String(FILE_LIMITS.textBytes + 1)
    await expect(show()).rejects.toMatchObject({ code: 'too-large' })
    expect(blobReads()).toHaveLength(0)
  })

  it('classifies binary blobs and preserves reported size', async () => {
    size = '2'
    content = '\0x'
    expect(await show()).toEqual({ binary: true, size: 2 })
  })

  it('applies the shared UTF-8 content bound after reading', async () => {
    size = '1'
    content = 'é'.repeat(FILE_LIMITS.textBytes / 2 + 1)
    await expect(show()).rejects.toMatchObject({ code: 'too-large' })
  })

  it('propagates subprocess failures for conversion by the public router', async () => {
    const error = new Error('missing tree')
    vi.mocked(files.safeGit).mockRejectedValue(error)
    await expect(show()).rejects.toBe(error)
  })
})
