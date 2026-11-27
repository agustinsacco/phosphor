import { randomBytes, randomUUID } from 'node:crypto'
import { createHostConnection } from '@phosphor/host-client/connection'
import { OPS_UNCONFIRMED, OPS_UNREADABLE } from '@phosphor/host-client/ops'
import { fetchSocketHello, openLocalSocket } from '@phosphor/session-runtime/host-local/transport'
import { nodeIdentity } from '@phosphor/session-runtime/pi/node-identity'
import {
  encodeLocalCredential,
  HOST_SIDECARS,
  hostConfigDirectory,
  hostStateDirectory,
  LOCAL_LIMITS,
  localEndpoint,
  localGrantIssueResponse,
  parseLocalIdentityFile,
  parseLocalRunFile,
} from '@phosphor/shared/host-local'
import { parseOpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { OpRequestEnvelope } from '@phosphor/shared/ops'
import type { CliContext } from './cli-handlers'
import { readSidecar } from './config/sidecar'
import { localSocketPaths } from './owner/socket'
import { OPS_CLI } from './ops/cli-method'

const NO_SOCKET =
  'No local Phosphor service socket. On a headless Host, use the phosphor tool in a lane on that Host, or use --host from a machine running the local Phosphor service.'

type Context = Pick<CliContext, 'env' | 'home' | 'uid' | 'platform'>
function location(ctx: Context) {
  const run = readSidecar(
    hostStateDirectory(ctx.env, ctx.home),
    HOST_SIDECARS.localRun,
    parseLocalRunFile,
    ctx,
  )
  if (run.state === 'missing') throw new Error(NO_SOCKET)
  if (run.state !== 'ok' || !localSocketPaths(ctx, ctx.platform).includes(run.value.socket))
    throw new Error('Invalid Phosphor service socket record.')
  const id = readSidecar(
    hostConfigDirectory(ctx.env, ctx.home),
    HOST_SIDECARS.localIdentity,
    parseLocalIdentityFile,
    ctx,
  )
  if (id.state !== 'ok' || id.value.machineId !== run.value.machineId)
    throw new Error('Invalid Phosphor service identity.')
  return { path: run.value.socket, ...id.value }
}

/** Fresh nonce even on renewal; no control grant, private key, TCP or lane subscription. */
export function openLocalClient(context: Context) {
  const { path, publicKey, machineId } = location(context)
  const lane = context.env.PI_SESSION_ID
  const client = { id: randomUUID(), label: 'Phosphor command line' }
  const endpoint = localEndpoint(machineId)
  let changed = () => {}
  const conn = createHostConnection({
    identity: nodeIdentity,
    hostId: machineId,
    endpoint,
    lanes: false,
    local: true,
    endpointAllowed: (value) => value === endpoint,
    socket: () => openLocalSocket(path),
    clearGrant: () => {},
    changed: () => changed(),
    grant: async () => {
      const hello = await fetchSocketHello(path, randomBytes(32).toString('hex'))
      if (hello.hostId !== machineId) throw new Error('grant-refused')
      const now = Date.now()
      const credential = encodeLocalCredential({
        v: 1,
        kind: 'local',
        machineId,
        client,
        lane,
        nonce: hello.nonce,
        iat: Math.floor(now / 1000),
      })
      return localGrantIssueResponse({
        machineId,
        credential,
        publicKey,
        expiresAt: new Date(now + LOCAL_LIMITS.grantTtlSec * 1000).toISOString(),
      })
    },
  })
  // Between polls a 1001 reconnects; never resend a call that may have acted.
  async function ready() {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(NO_SOCKET)), 12_000)
      changed = () => {
        const view = conn.snapshot()
        if (view.state === 'ready') {
          clearTimeout(timer)
          if (view.ops) resolve()
          else reject(new Error('The local Phosphor service is not serving operations.'))
        } else if (
          view.lastError === 'offline' ||
          view.state === 'wrong-machine' ||
          view.lastError === 'forbidden'
        ) {
          clearTimeout(timer)
          reject(
            new Error(
              view.lastError === 'offline' ? NO_SOCKET : 'Phosphor service authentication failed.',
            ),
          )
        }
      }
      changed()
    }).finally(() => {
      changed = () => {}
    })
  }
  return {
    close: conn.close,
    async run(envelope: OpRequestEnvelope) {
      await ready()
      const frame = await conn.call(OPS_CLI, envelope, envelope.deadlineMs + 2000)
      if (!frame.ok)
        throw new Error(frame.error.code === 'internal' ? OPS_UNCONFIRMED : frame.error.message)
      const result = parseOpsRunResult(frame.data)
      if (!result) throw new Error(OPS_UNREADABLE)
      return result
    },
  }
}
