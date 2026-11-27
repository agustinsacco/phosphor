import type { BrainAccess } from '@phosphor/shared/brain-access'
import {
  BRAIN_APPROVAL,
  BRAIN_METHODS,
  BRAIN_SURFACE,
  type HostBrainMethod,
  type HostBrainMap,
} from '@phosphor/shared/host-brain'
import {
  brainClientMayInvoke,
  parseHostBrainRequest,
  type HostBrainRequest,
} from '@phosphor/shared/host-brain-request'
import { projectHostBrainResult } from '@phosphor/shared/host-brain-result'
import { splitGrant } from '@phosphor/shared/host-grant'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { ConfirmInfo } from '@phosphor/shared/ops'
import type { createHostConnection } from './connection'
import { opsRun } from './ops'

type Connection = Pick<
  ReturnType<typeof createHostConnection>,
  'snapshot' | 'incarnation' | 'brainAuthorityEpoch' | 'call' | 'send'
>
export class HostBrainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HostBrainError'
  }
}
const interrupted = () =>
  new HostBrainError(
    'interrupted',
    'Brain connection or access changed. Check this Host before trying again.',
  )
const unsupported = () =>
  new HostBrainError(
    'unsupported',
    'This Host does not serve Brain. Update or connect to a supported Host.',
  )

function approvalSummaries(data: unknown[]) {
  return data.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const { confirmId, title, message, expiresAt } = item as Partial<ConfirmInfo>
    return typeof confirmId === 'string' &&
      typeof title === 'string' &&
      typeof message === 'string' &&
      typeof expiresAt === 'number'
      ? [{ confirmId, title, message, expiresAt }]
      : []
  })
}

/** A Host reply as the method's result, or the refusal it carries. */
function brainResult<K extends HostBrainMethod>(
  method: K,
  reply: OpsRunResult,
): HostBrainMap[K]['result'] {
  if (reply.status !== 'ok')
    throw new HostBrainError(
      reply.status === 'denied' ? reply.code : 'approval-required',
      reply.status === 'denied' ? reply.text : 'Brain access requires approval.',
    )
  if (
    reply.data &&
    typeof reply.data === 'object' &&
    'brainRefusal' in reply.data &&
    typeof reply.data.brainRefusal === 'string'
  )
    throw new HostBrainError(reply.data.brainRefusal, reply.text)
  const projected = projectHostBrainResult(method, reply.data)
  if (!projected)
    throw new HostBrainError('invalid-result', 'The Host did not return a valid Brain result.')
  return projected.value
}

/** Explicit single target. No local fallback and no replay of writes. */
export type HostBrainTarget = { hostId: string; connectionToken: string }

export function hostBrain(lookup: (hostId: string) => Connection | undefined) {
  function ready(hostId: string) {
    const conn = lookup(hostId)
    if (!conn || conn.snapshot().state !== 'ready') throw interrupted()
    if (!conn.snapshot().brain) throw unsupported()
    const { generation } = conn.incarnation()
    const epoch = conn.brainAuthorityEpoch()
    const active = () =>
      lookup(hostId) === conn &&
      conn.incarnation().generation === generation &&
      conn.brainAuthorityEpoch() === epoch &&
      conn.snapshot().brain &&
      conn.snapshot().state === 'ready'
    const has = (method: HostBrainMethod) =>
      brainClientMayInvoke(
        method,
        conn.snapshot().brainAccess ?? [],
        conn.snapshot().capabilities ?? [],
      )
    return { conn, active, has }
  }
  return {
    async invoke<K extends HostBrainMethod>(
      { hostId, connectionToken }: HostBrainTarget,
      request: HostBrainRequest<K>,
    ): Promise<HostBrainMap[K]['result']> {
      const action = parseHostBrainRequest(request)
      if (!action) throw new HostBrainError('bad-request', 'Invalid Brain operation.')
      const { conn, active, has } = ready(hostId)
      if (conn.snapshot().connectionToken !== connectionToken) throw interrupted()
      if (!has(action.method))
        throw new HostBrainError('forbidden', 'Enable access to Brain on this Host first.')
      const reply = await opsRun(
        conn,
        { op: BRAIN_SURFACE, args: action },
        { write: BRAIN_METHODS[action.method][1] },
      )
      if (!active() || !has(action.method)) throw interrupted()
      return brainResult(request.method, reply)
    },
    async listApprovals(
      hostId: string,
    ): Promise<Pick<ConfirmInfo, 'confirmId' | 'title' | 'message' | 'expiresAt'>[]> {
      const { conn, active } = ready(hostId)
      const result = await opsRun(
        conn,
        { op: BRAIN_APPROVAL, args: { action: 'list' } },
        { write: false },
      )
      if (!active()) throw interrupted()
      if (result.status !== 'ok' || !Array.isArray(result.data)) return []
      return approvalSummaries(result.data)
    },
    async answerApproval(hostId: string, id: string, approved: boolean): Promise<void> {
      const { conn, active } = ready(hostId)
      const result = await opsRun(
        conn,
        { op: BRAIN_APPROVAL, args: { action: 'answer', id, approved } },
        { write: true },
      )
      if (!active()) throw interrupted()
      if (result.status !== 'ok')
        throw new HostBrainError('forbidden', 'Brain approval was refused.')
    },
  }
}

/** A surface's per-Host in-memory opt-in port. Issuing without the claim fails closed. */
export async function enableBrainAccess(
  ports: {
    connection(hostId: string): Pick<Connection, 'snapshot'> | undefined
    grants: {
      setBrainAccess(hostId: string, rights: readonly BrainAccess[]): void
      grantFor(hostId: string): Promise<{ grant: string }>
    }
    reconnect(hostId: string): Promise<void>
  },
  hostId: string,
  rights: readonly BrainAccess[],
) {
  const snapshot = ports.connection(hostId)?.snapshot()
  if (snapshot?.state !== 'ready' || !snapshot.brain) throw unsupported()
  ports.grants.setBrainAccess(hostId, rights)
  try {
    const grant = splitGrant((await ports.grants.grantFor(hostId)).grant)
    if (
      !grant.ok ||
      grant.value.payload.hostId !== hostId ||
      rights.some((right) => !grant.value.payload.brainAccess?.includes(right))
    )
      throw unsupported()
    await ports.reconnect(hostId)
  } catch {
    ports.grants.setBrainAccess(hostId, [])
    throw new HostBrainError('forbidden', 'Control did not grant Brain access on this Host.')
  }
}
