import { realpath, stat } from 'node:fs/promises'
import { sep } from 'node:path'
import { parseFileParams, type FileParams } from '@phosphor/shared/host-protocol-files'
import { FILE_BYTES_METHOD, parseFileBytesParams } from '@phosphor/shared/host-protocol-file-bytes'
import { errnoIs } from '../../fs-safety'
import type { FeatureContext, FeatureOutcome } from '../feature'
import { guardedBytes, guardedRead, type ReadPorts } from './read'

export interface QueryPorts extends ReadPorts {
  laneRoot(context: FeatureContext, laneId: string): Promise<string>
  filePaths(root: string): Promise<string[]>
  failure(error: unknown): FeatureOutcome
}

async function queryRoot(context: FeatureContext, p: FileParams, ports: QueryPorts) {
  const repository =
    p.repositoryId === undefined
      ? null
      : context.store.listRepositories().find((r) => r.id === p.repositoryId)
  if (p.repositoryId !== undefined && !repository) throw ports.error('bad-request')
  const root = repository
    ? await realpath(repository.path)
    : p.laneId
      ? await ports.laneRoot(context, p.laneId)
      : null
  if (
    !root ||
    root.split(sep).some((s) => s.toLowerCase() === '.git') ||
    !(await stat(root)).isDirectory()
  )
    throw ports.error('bad-request')
  const recheck = () => {
    if (
      repository &&
      !context.store
        .listRepositories()
        .some((r) => r.id === repository.id && r.path === repository.path)
    )
      throw ports.error('bad-request')
    if (p.laneId && context.store.getLane(p.laneId)?.removedAt !== null)
      throw ports.error('unknown-lane')
  }
  return { root, recheck }
}

function parseQuery(method: string, params: unknown) {
  if (method === FILE_BYTES_METHOD) {
    const bytes = parseFileBytesParams(params)
    return bytes && { target: bytes, bytes }
  }
  const target = ['files.list', 'files.read'].includes(method)
    ? parseFileParams(method, params)
    : null
  return target && { target, bytes: null }
}

export async function queryFiles(
  context: FeatureContext,
  method: string,
  params: unknown,
  ports: QueryPorts,
): Promise<FeatureOutcome> {
  const query = parseQuery(method, params)
  if (!query) return ports.failure(ports.error('bad-request'))
  const p = query.target
  try {
    const { root, recheck } = await queryRoot(context, p, ports)
    if (query.bytes) return await guardedBytes(root, query.bytes, recheck, ports)
    if (method === 'files.list') {
      const files = await ports.filePaths(root)
      recheck()
      return { ok: true, data: { files } }
    }
    if (!p.path) throw ports.error('bad-request')
    return await guardedRead(root, p.path, recheck, ports)
  } catch (error) {
    if (method === 'files.read' && errnoIs(error, 'ENOENT'))
      return { ok: true, data: { binary: false, size: 0, content: '', revision: null } }
    const result = ports.failure(error)
    context.log('feature-query', {
      scope: p.laneId ? 'lane' : 'repository',
      method,
      reason: result.ok ? 'ok' : result.error.code,
    })
    return result
  }
}
