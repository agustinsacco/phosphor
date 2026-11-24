import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { encodeGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import {
  parseClientFrame,
  type ClientFrame,
  type FrameSocket,
} from '@phosphor/shared/host-protocol'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import {
  createFakeHost,
  createLoopbackPair,
  type FakeOpsHandler,
} from '@phosphor/shared/host-protocol-testing'
import type { ReachControl } from '../directory'

/** Reach tests: a fake control plane and fake sibling Hosts on in-memory sockets. No network. */
export const ISS = 'http://localhost:12345'
export const OWNER = randomUUID()
export const SELF = { id: randomUUID(), label: 'stark' }
export const LANE_LIST_OK: OpsRunResult = {
  status: 'ok',
  text: 'No lanes.',
  applies: 'now',
  data: { lanes: [] },
}

const controlKeys = generateKeyPairSync('ed25519')

export function reachControl(): ReachControl {
  return {
    url: 'https://control.test',
    hostId: SELF.id,
    key: generateKeyPairSync('ed25519').privateKey,
  }
}

export interface Sibling {
  readonly id: string
  readonly label: string
  readonly endpoint: string
  readonly publicKey: string
  readonly clientId: string
  readonly driver: ReturnType<typeof createFakeHost>
  /** Every frame this machine's pool sent to the sibling. */
  readonly sent: ClientFrame[]
  readonly sockets: ReturnType<typeof createLoopbackPair>[]
  /** The calls and writes the sibling's ops handler saw. */
  readonly ops: { op: string; write: boolean }[]
}

/** A sibling Host serving `ops.run` with `answer` (null: an older Host without `ready.ops`). */
export function sibling(
  label: string,
  answer: FakeOpsHandler | null = () => LANE_LIST_OK,
): Sibling {
  const keys = generateKeyPairSync('ed25519')
  const id = randomUUID()
  const publicKey = keys.publicKey.export({ format: 'jwk' }).x
  if (!publicKey) throw new Error('No public key')
  const driver = createFakeHost({
    expectations: { iss: ISS, hostId: id, owner: OWNER, epoch: 1, machineOrigin: true },
    id: randomUUID,
    epoch: () => randomBytes(8).toString('hex'),
    sign: (bytes) => sign(null, bytes, keys.privateKey),
    verify: (bytes, signature, kid) =>
      kid === 'test-key' && verify(null, bytes, controlKeys.publicKey, signature),
  })
  const ops: Sibling['ops'] = []
  if (answer)
    driver.ops((request, principal, write) => {
      ops.push({ op: request.op, write })
      return answer(request, principal, write)
    })
  const endpoint = `https://${label}.tailnet.ts.net`
  return {
    id,
    label,
    endpoint,
    publicKey,
    clientId: randomUUID(),
    driver,
    sent: [],
    sockets: [],
    ops,
  }
}

/** A machine grant as control signs it: no caps, `origin: 'machine'`. */
export function machineGrant(target: Sibling, ttlSec = 300) {
  const iat = Math.floor(Date.now() / 1000)
  const claims: GrantPayload = {
    v: 1,
    iss: ISS,
    kid: 'test-key',
    sub: OWNER,
    sid: randomUUID(),
    hostId: target.id,
    epoch: 1,
    client: { id: target.clientId, label: SELF.label },
    caps: [],
    iat,
    exp: iat + Math.min(ttlSec, 300),
    jti: randomBytes(8).toString('hex'),
    origin: 'machine',
    machine: SELF.id,
  }
  return {
    grant: encodeGrant(claims, (bytes) => sign(null, bytes, controlKeys.privateKey)),
    expiresAt: new Date((iat + ttlSec) * 1000).toISOString(),
    host: { id: target.id, endpoint: target.endpoint, publicKey: target.publicKey },
  }
}

/** The injected socket: one loopback pair per open, attached to the sibling at `url`. */
export function siblingSockets(siblings: readonly Sibling[]) {
  return (url: string): Promise<FrameSocket> => {
    const target = siblings.find((s) => url === `${s.endpoint.replace('https:', 'wss:')}/v1/stream`)
    if (!target) return Promise.reject(new Error('offline'))
    const pair = createLoopbackPair()
    target.driver.attach(pair.server)
    target.sockets.push(pair)
    const send = pair.client.send
    return Promise.resolve({
      ...pair.client,
      send(text: string) {
        const parsed = parseClientFrame(text)
        if (parsed.ok) target.sent.push(parsed.frame)
        send(text)
      },
    })
  }
}

export interface DirectoryEntryOverrides {
  readonly state?: 'running' | 'stopping' | null
  readonly lastSeenAt?: string | null
  readonly machineGrants?: boolean
  readonly machineReach?: boolean
  readonly reachable?: boolean
  readonly hostVersion?: string | null
}

export function directoryEntry(
  target: Pick<Sibling, 'id' | 'label'>,
  o: DirectoryEntryOverrides = {},
) {
  return {
    id: target.id,
    label: target.label,
    hostVersion: o.hostVersion === undefined ? '0.3.0' : o.hostVersion,
    lastSeenAt: o.lastSeenAt === undefined ? new Date().toISOString() : o.lastSeenAt,
    state: o.state === undefined ? 'running' : o.state,
    readiness: null,
    machineGrants: o.machineGrants ?? true,
    machineReach: o.machineReach ?? true,
    reachable: o.reachable ?? true,
  }
}

export interface ControlCall {
  readonly method: string
  readonly path: string
  readonly body: string
  readonly headers: Headers
}

/** An answer: a JSON body with 200, or an error code with its status. */
export type ControlAnswer =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: number; readonly code: string }
  | 'offline'

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fake control plane: records each signed request and answers from `route`. */
export function fakeControl(route: (call: ControlCall) => ControlAnswer) {
  const calls: ControlCall[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? init.body : '',
      headers: new Headers(init?.headers),
    }
    calls.push(call)
    const answer = route(call)
    if (answer === 'offline') throw new TypeError('fetch failed')
    if ('body' in answer) return json(answer.status, answer.body)
    return json(answer.status, { error: { code: answer.code, message: answer.code } })
  }
  return { fetch, calls }
}
