import {
  fileListFailure,
  parseFileParams,
  parseFileResult,
  type FileRead,
} from '@phosphor/shared/host-protocol-files'
import {
  parseRemotePrKey,
  parsePrParams,
  parsePrReadOptions,
  parseRepoPrs,
} from '@phosphor/shared/host-protocol-github'
import type { GhPrReadOptions } from '@phosphor/shared/models'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

export function repositoryReads(
  connection: (
    hostId: string,
  ) =>
    Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'call'> | undefined,
) {
  async function call(
    hostId: string,
    repositoryId: string,
    method: string,
    path?: string,
    options?: GhPrReadOptions,
  ) {
    const c = connection(hostId)
    const params =
      method === 'github.prs'
        ? parsePrParams({ repositoryId, options }) && {
            repositoryId,
            ...(options ? { options } : {}),
          }
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
    // A failed list names its cause in fixed text; every other failure is "unavailable".
    let failure = REMOTE_UNAVAILABLE
    try {
      let reply = await c.call(method, params)
      // An older Host rejects the additive options field. Never retry operational failures.
      if (
        available() &&
        method === 'github.prs' &&
        options &&
        !reply.ok &&
        reply.error.code === 'bad-request'
      )
        reply = await c.call(method, { repositoryId })
      if (available() && !reply.ok && method === 'files.list')
        failure = fileListFailure(reply.error.code) ?? REMOTE_UNAVAILABLE
      if (!available() || !reply.ok) throw new Error(REMOTE_UNAVAILABLE)
      if (method === 'github.prs') return { prs: parseRepoPrs(reply.data) }
      const parsed = parseFileResult(method, reply.data)
      if (!parsed) throw new Error(REMOTE_UNAVAILABLE)
      return parsed
    } catch {
      throw new Error(failure)
    }
  }
  return {
    async pullRequests(key: string, options?: unknown) {
      const scope = parseRemotePrKey(key)
      const parsed = options === undefined ? undefined : parsePrReadOptions(options)
      if (!scope || parsed === null) throw new Error(REMOTE_UNAVAILABLE)
      const result = await call(scope.hostId, scope.repositoryId, 'github.prs', undefined, parsed)
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
