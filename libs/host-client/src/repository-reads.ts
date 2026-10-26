import {
  parseFileParams,
  parseFileResult,
  type FileRead,
} from '@phosphor/shared/host-protocol-files'
import {
  parseRemotePrKey,
  parsePrParams,
  parseRepoPrs,
} from '@phosphor/shared/host-protocol-github'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

export function repositoryReads(
  connection: (
    hostId: string,
  ) =>
    Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'call'> | undefined,
) {
  async function call(hostId: string, repositoryId: string, method: string, path?: string) {
    const c = connection(hostId)
    const params =
      method === 'github.prs'
        ? parsePrParams({ repositoryId }) && { repositoryId }
        : parseFileParams(method, {
            repositoryId,
            ...(path === undefined ? {} : { path }),
          })
    if (!c || !params) throw new Error(REMOTE_UNAVAILABLE)
    const generation = c.incarnation().generation
    const available = () =>
      connection(hostId) === c &&
      c.incarnation().generation === generation &&
      c.snapshot().state === 'ready' &&
      c.snapshot().capabilities.includes('workspaces.read') &&
      c.snapshot().repositories.some((r) => r.id === repositoryId)
    if (!available()) throw new Error(REMOTE_UNAVAILABLE)
    try {
      const reply = await c.call(method, params)
      if (!available() || !reply.ok) throw new Error(REMOTE_UNAVAILABLE)
      if (method === 'github.prs') return { prs: parseRepoPrs(reply.data) }
      const parsed = parseFileResult(method, reply.data)
      if (!parsed) throw new Error(REMOTE_UNAVAILABLE)
      return parsed
    } catch {
      throw new Error(REMOTE_UNAVAILABLE)
    }
  }
  return {
    async pullRequests(key: string) {
      const scope = parseRemotePrKey(key)
      if (!scope) throw new Error(REMOTE_UNAVAILABLE)
      const result = await call(scope.hostId, scope.repositoryId, 'github.prs')
      if (!('prs' in result)) throw new Error(REMOTE_UNAVAILABLE)
      return result.prs
    },
    async list(hostId: string, repositoryId: string): Promise<string[]> {
      const result = await call(hostId, repositoryId, 'files.list')
      if (!('files' in result)) throw new Error(REMOTE_UNAVAILABLE)
      return result.files
    },
    async read(hostId: string, repositoryId: string, path: string): Promise<FileRead> {
      const result = await call(hostId, repositoryId, 'files.read', path)
      if (!('binary' in result)) throw new Error(REMOTE_UNAVAILABLE)
      return result
    },
  }
}
