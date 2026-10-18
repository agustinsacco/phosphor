import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { checkedPath, failure, FileFailure, readResult } from '../files'
import type { FeatureContext } from '../feature'
import { queryFiles, type QueryPorts } from './query'

let root: string
let context: FeatureContext
let ports: QueryPorts
const repositoryId = '1234567890abcdef'
const laneId = randomUUID()
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'file-query-')))
  await writeFile(join(root, 'file'), 'text')
  context = {
    store: {
      listRepositories: vi.fn(() => [{ id: repositoryId, name: 'repo', path: root }]),
      getLane: vi.fn(() => null),
    },
    env: {},
    home: root,
    log: vi.fn(),
  }
  ports = {
    checkedPath,
    failure,
    readResult,
    error: (code) => new FileFailure(code),
    laneRoot: vi.fn(async () => root),
    filePaths: vi.fn(async () => ['file']),
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const bad = { ok: false, error: { code: 'bad-request', message: 'Invalid file request.' } }
describe('queryFiles', () => {
  it('rejects invalid admission before resolving roots or logging', async () => {
    for (const [method, params] of [
      ['files.list', {}],
      ['git.status', { laneId }],
      ['files.read', { repositoryId, path: '../file' }],
    ] as const)
      expect(await queryFiles(context, method, params, ports)).toEqual(bad)
    expect(context.store.listRepositories).not.toHaveBeenCalled()
    expect(ports.laneRoot).not.toHaveBeenCalled()
    expect(context.log).not.toHaveBeenCalled()
  })
  it('dispatches repository listing and reads with unchanged envelopes', async () => {
    expect(await queryFiles(context, 'files.list', { repositoryId }, ports)).toEqual({
      ok: true,
      data: { files: ['file'] },
    })
    expect(
      await queryFiles(context, 'files.read', { repositoryId, path: 'file' }, ports),
    ).toMatchObject({ ok: true, data: { content: 'text', size: 4 } })
    expect(ports.filePaths).toHaveBeenCalledWith(root)
  })
  it('refuses unknown repositories and non-directory or metadata roots', async () => {
    expect(
      await queryFiles(context, 'files.list', { repositoryId: '0000000000000000' }, ports),
    ).toEqual(bad)
    for (const path of [join(root, 'file'), join(root, '.git')]) {
      if (path.endsWith('.git')) await mkdir(path)
      vi.mocked(context.store.listRepositories).mockReturnValue([
        { id: repositoryId, name: 'repo', path },
      ])
      expect(await queryFiles(context, 'files.list', { repositoryId }, ports)).toEqual(bad)
    }
  })
  it('rechecks repository admission after listing', async () => {
    vi.mocked(ports.filePaths).mockImplementation(async () => {
      vi.mocked(context.store.listRepositories).mockReturnValue([])
      return ['file']
    })
    expect(await queryFiles(context, 'files.list', { repositoryId }, ports)).toEqual(bad)
  })
  it('rechecks lane removal after listing', async () => {
    expect(await queryFiles(context, 'files.list', { laneId }, ports)).toEqual({
      ok: false,
      error: { code: 'unknown-lane', message: 'Lane is unavailable.' },
    })
    expect(ports.laneRoot).toHaveBeenCalledWith(context, laneId)
  })
  it('maps structural missing errors only on reads and logs safe errors otherwise', async () => {
    vi.mocked(ports.laneRoot).mockRejectedValue({ code: 'ENOENT' })
    expect(await queryFiles(context, 'files.read', { laneId, path: 'file' }, ports)).toEqual({
      ok: true,
      data: { binary: false, size: 0, content: '', revision: null },
    })
    expect(context.log).not.toHaveBeenCalled()
    expect(await queryFiles(context, 'files.list', { laneId }, ports)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'File query failed.' },
    })
    expect(context.log).toHaveBeenCalledWith('feature-query', {
      scope: 'lane',
      method: 'files.list',
      reason: 'internal',
    })
  })
  it('maps list failures without leaking private details', async () => {
    vi.mocked(ports.filePaths).mockRejectedValue(new Error(root))
    expect(await queryFiles(context, 'files.list', { repositoryId }, ports)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'File query failed.' },
    })
    expect(context.log).toHaveBeenCalledWith('feature-query', {
      scope: 'repository',
      method: 'files.list',
      reason: 'internal',
    })
  })
})
