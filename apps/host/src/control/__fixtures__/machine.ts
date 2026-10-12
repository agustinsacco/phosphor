import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatKeyFingerprint, HOST_HEADERS, CONTROL_ROUTES } from '@phosphor/shared/control-api'
import type { ControlContext } from '../command'
import { createIdentityStore, identityDirectory, type HostIdentity } from '../identity'
import { freshKey } from '../signer'

export const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
export const oldId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d01'
export const timestamp = '2026-10-10T00:00:00.000Z'
export const serverView = {
  hostId,
  label: 'bee1',
  owner: { login: 'me' },
  enrolledAt: timestamp,
  lastSeenAt: null,
}
export const oldIdentity: HostIdentity = {
  version: 1,
  hostId: oldId,
  label: 'earlier',
  ownerLogin: 'me',
  controlUrl: 'https://example.com',
  savedAt: timestamp,
}

export async function controlMachine() {
  const root = await mkdtemp(join(tmpdir(), 'host-control-'))
  const configPath = join(root, 'conf', 'config.json')
  await mkdir(join(root, 'conf'), { mode: 0o700 })
  const config = {
    version: 1,
    pi: { executable: '/usr/bin/pi' },
    repositories: ['/srv/a'],
    control: { url: 'https://example.com' },
  }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const store = createIdentityStore(identityDirectory(configPath), process.getuid?.())
  const calls: { path: string; method: string; body: string; headers: Headers; at: number }[] = []
  const output: string[] = []
  const waits: number[] = []
  const abort = new AbortController()
  let clock = Date.parse(timestamp)
  let polls = 0
  let answer: unknown = { status: 'approved', hostId, label: 'bee1', owner: { login: 'me' } }
  type Mode = 'ok' | 'gone' | 'offline' | 'unavailable'
  let mode: Mode = 'ok'
  let finalMode: Mode = 'ok'
  let onWait: (() => Promise<void> | void) | undefined
  let creation: Record<string, unknown> = {}
  const context: ControlContext = {
    configPath,
    uid: process.getuid?.(),
    hostname: 'bee1',
    platform: 'linux',
    arch: 'x64',
    store,
    signal: abort.signal,
    now: () => clock,
    print: (line) => {
      output.push(line)
    },
    wait: async (ms) => {
      waits.push(ms)
      clock += ms
      await onWait?.()
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ path, headers, body, method: init?.method ?? '', at: clock })
      const chosen = headers.get(HOST_HEADERS.host) === hostId ? finalMode : mode
      if (chosen === 'offline') throw new Error('transport contains secret')
      if (chosen === 'gone' && path.startsWith(CONTROL_ROUTES.hostSelf))
        return new Response('secret', { status: 410 })
      if (chosen === 'unavailable')
        return Response.json({ error: { code: 'unavailable', message: 'secret' } }, { status: 503 })
      if (path === CONTROL_ROUTES.enrollments) {
        const raw = Buffer.from(headers.get(HOST_HEADERS.key) ?? '', 'base64url')
        return Response.json({
          enrollmentId: hostId,
          userCode: 'BCDFGHJK',
          keyFingerprint: formatKeyFingerprint(createHash('sha256').update(raw).digest()),
          expiresAt: new Date(clock + 600_000).toISOString(),
          pollIntervalSec: 5,
          ...creation,
        })
      }
      if (path === CONTROL_ROUTES.enrollmentPoll) {
        polls++
        return Response.json(answer)
      }
      if (path === CONTROL_ROUTES.hostRevoke) return new Response(null, { status: 204 })
      return Response.json({ ...serverView, hostId: headers.get(HOST_HEADERS.host) })
    },
  }
  return {
    root,
    configPath,
    config,
    store,
    context,
    calls,
    output,
    waits,
    abort,
    setMode: (value: Mode) => {
      mode = value
    },
    setFinalMode: (value: Mode) => {
      finalMode = value
    },
    setAnswer: (value: unknown) => {
      answer = value
    },
    setCreation: (value: Record<string, unknown>) => {
      creation = value
    },
    onWait: (value: typeof onWait) => {
      onWait = value
    },
    polls: () => polls,
    enrollOld: () => store.save(oldIdentity, freshKey()),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
export type ControlMachine = Awaited<ReturnType<typeof controlMachine>>
