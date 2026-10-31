import { describe, expect, it } from 'vitest'
import {
  FILE_LIMITS,
  FILE_LIST_FAILED,
  FILE_LIST_TOO_LARGE,
  fileListErrorText,
  fileListFailure,
  isFilePath,
  parseFileParams,
  parseFileResult,
} from './host-protocol-files'
const laneId = '12345678-1234-4234-8234-123456789abc'
describe('host protocol files', () => {
  it('rejects unsafe paths and accepts POSIX paths at the bound', () => {
    for (const path of [
      '',
      '/a',
      '../a',
      'a/../b',
      'a/./b',
      'a//b',
      'a\\b',
      'C:/a',
      'a\0b',
      '.git/config',
      'a/.GIT/config',
    ])
      expect(isFilePath(path)).toBe(false)
    expect(isFilePath('é folder/a')).toBe(true)
    expect(isFilePath('a'.repeat(FILE_LIMITS.pathChars))).toBe(true)
    expect(isFilePath('a'.repeat(FILE_LIMITS.pathChars + 1))).toBe(false)
  })
  it('checks exact method fields, UUIDs, booleans and refs', () => {
    expect(parseFileParams('files.list', { laneId })).toEqual({ laneId })
    expect(parseFileParams('git.diff', { laneId, path: 'a', staged: false })).toEqual({
      laneId,
      path: 'a',
      staged: false,
    })
    expect(parseFileParams('git.show', { laneId, path: 'a', ref: 'HEAD' })).toEqual({
      laneId,
      path: 'a',
      ref: 'HEAD',
    })
    for (const [method, params] of [
      ['no.method', { laneId }],
      ['files.list', { laneId, path: 'a' }],
      ['files.read', { laneId }],
      ['git.diff', { laneId, staged: 'true' }],
      ['git.show', { laneId, path: 'a', ref: '--help' }],
      ['files.list', { laneId: 'no' }],
    ])
      expect(parseFileParams(String(method), params)).toBeNull()
    for (const v of [null, [], 1, 'x']) expect(parseFileParams('files.list', v)).toBeNull()
  })
  it('admits exactly one file scope, and never repository-scopes git', () => {
    const repositoryId = '1234567890abcdef'
    for (const method of ['files.list', 'files.read']) {
      const path = method === 'files.read' ? { path: 'README.md' } : {}
      expect(parseFileParams(method, { repositoryId, ...path })).toEqual({ repositoryId, ...path })
      for (const scope of [
        {},
        { repositoryId, laneId },
        { repositoryId: 'bad' },
        { repositoryId, extra: true },
      ])
        expect(parseFileParams(method, { ...scope, ...path })).toBeNull()
    }
    for (const method of ['git.status', 'git.diff', 'git.show'])
      expect(parseFileParams(method, { repositoryId })).toBeNull()
  })
  it('validates result shapes and byte or entry caps', () => {
    expect(parseFileResult('files.read', { binary: true, size: 3 })).toEqual({
      binary: true,
      size: 3,
    })
    expect(
      parseFileResult('files.read', {
        binary: false,
        size: 1,
        content: 'x',
        revision: 'a'.repeat(64),
      }),
    ).not.toBeNull()
    expect(parseFileResult('files.read', { binary: true, size: 3, content: 'secret' })).toBeNull()
    expect(parseFileResult('files.read', { binary: false, size: -1, content: '' })).toBeNull()
    expect(
      parseFileResult('files.list', { files: Array(FILE_LIMITS.entries).fill('a') }),
    ).not.toBeNull()
    expect(
      parseFileResult('files.list', { files: Array(FILE_LIMITS.entries + 1).fill('a') }),
    ).toBeNull()
    expect(parseFileResult('files.list', { files: ['../a'] })).toBeNull()
    expect(parseFileResult('git.diff', { diff: 'x'.repeat(FILE_LIMITS.textBytes) })).not.toBeNull()
    expect(
      parseFileResult('git.diff', { diff: 'é'.repeat(FILE_LIMITS.textBytes / 2 + 1) }),
    ).toBeNull()
    expect(
      parseFileResult('git.status', { status: { a: ' M' }, branch: 'main', ahead: 0, behind: 1 }),
    ).not.toBeNull()
    expect(
      parseFileResult('git.status', { status: { a: 'xx' }, branch: null, ahead: 0, behind: 0 }),
    ).toBeNull()
  })
})

describe('file list failure texts', () => {
  it('maps only too-large and internal to fixed text', () => {
    expect(FILE_LIST_TOO_LARGE).toBe('Too many files to list: the Host stops at 20,000.')
    expect(fileListFailure('too-large')).toBe(FILE_LIST_TOO_LARGE)
    expect(fileListFailure('internal')).toBe(FILE_LIST_FAILED)
    for (const code of ['bad-request', 'unknown-lane', 'unsupported', 'Result exceeds the limit.'])
      expect(fileListFailure(code)).toBeNull()
  })
  it('recognises the fixed text through IPC and nothing near it', () => {
    const ipc = (m: string) => new Error(`Error invoking remote method 'fs:listFiles': Error: ${m}`)
    expect(fileListErrorText(ipc(FILE_LIST_FAILED), 'x')).toBe(FILE_LIST_FAILED)
    expect(fileListErrorText(new Error(FILE_LIST_TOO_LARGE), 'x')).toBe(FILE_LIST_TOO_LARGE)
    for (const other of [ipc(`${FILE_LIST_FAILED} /private`), 'too-large', null, undefined])
      expect(fileListErrorText(other, 'x')).toBe('x')
  })
})
