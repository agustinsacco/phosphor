import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { describe, expect, it } from 'vitest'
import {
  CONTROL_ROUTES as R,
  isUuid,
  parseEnrollmentCreateResponse,
  parseEnrollmentLookupResponse,
  parseEnrollmentPollResponse,
  parseEnrollmentApproveResponse,
  parseMachinesResponse,
  parseHostSelfResponse,
} from '@phosphor/shared/control-api'
import { createGoTrue, pkcePair } from '../../../desktop/electron/account/gotrue'
import { listenForCallback } from '../../../desktop/electron/account/loopback'
import { createApp } from '../app'
import { parseConfig } from '../config'
import { createSupabase } from '../supabase'
import { RateLimiter, NonceCache } from '../limits'
import { signingKey } from '../test-support'
import { parsed, record } from './shared'

const url = process.env.PHOSPHOR_AUTH_STACK_URL
const key = process.env.PHOSPHOR_AUTH_STACK_KEY ?? ''
const secret = process.env.PHOSPHOR_CONTROL_STACK_SECRET ?? ''
const github = process.env.PHOSPHOR_AUTH_STACK_GITHUB ?? ''
describe.runIf(url && secret)('control API against the isolated Supabase stack', () => {
  it('enrolls, isolates owners, beats, revokes and rejects a signed-out session', async () => {
    if (url !== 'http://127.0.0.1:54351' || !secret.startsWith('sb_secret_'))
      throw new Error('Not the isolated stack')
    const stackUrl = url
    const auth = createGoTrue({ url: stackUrl, key }, fetch, Date.now)
    const users: string[] = []
    const hosts: string[] = []
    const enrollmentIds: string[] = []
    const config = parseConfig({
      PORT: '0',
      SUPABASE_URL: stackUrl,
      SUPABASE_PUBLISHABLE_KEY: key,
      SUPABASE_SECRET_KEY: secret,
    })
    let rpcCalls = 0
    const recordingFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('/rest/v1/rpc/')) {
        rpcCalls++
        const headers = new Headers(init?.headers)
        expect(headers.get('apikey') === secret).toBe(true)
        expect(headers.has('authorization')).toBe(false)
      }
      const response = await fetch(input, init)
      if (String(input).endsWith('/rpc/control_enrollment_create') && response.ok) {
        const value = record(await response.clone().json())
        if (isUuid(value.enrollmentId)) enrollmentIds.push(value.enrollmentId)
      }
      return response
    }
    const supabase = createSupabase(config, recordingFetch)
    const app = () =>
      createApp({
        config,
        clock: Date.now,
        random: randomBytes,
        fetch: recordingFetch,
        log: () => {},
        supabase,
        limits: new RateLimiter(Date.now),
        nonces: { key: new NonceCache(Date.now), host: new NonceCache(Date.now) },
        version: 'stack-test',
      })
    const server = serve({ fetch: app().fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((done) => server.once('listening', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    const origin = `http://127.0.0.1:${address.port}`
    const userRequest = (token: string, path: string, method = 'GET', body?: unknown) =>
      fetch(origin + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      })
    const signed = (
      signer: ReturnType<typeof signingKey>,
      path: string,
      method: string,
      body?: unknown,
      id?: string,
    ) => {
      const request = signer.request(method, path, body, Date.now(), id)
      return fetch(new Request(origin + path, request), { signal: AbortSignal.timeout(5000) })
    }
    async function signIn(profile: 'a' | 'b') {
      expect(
        (
          await fetch(github + '/__user', {
            method: 'POST',
            body: profile,
            signal: AbortSignal.timeout(5000),
          })
        ).ok,
      ).toBe(true)
      const pair = pkcePair()
      const listener = await listenForCallback(30_000)
      const browser = async () => {
        let next = new URL(auth.authorizeUrl(listener.url, pair.challenge))
        for (let hop = 0; hop < 8; hop++) {
          if (next.origin === 'http://fake-github:54353') next.host = new URL(github).host
          if (![stackUrl, github, new URL(listener.url).origin].includes(next.origin))
            throw new Error('Unexpected sign-in redirect')
          const response = await fetch(next, {
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          })
          const location = response.headers.get('location')
          await response.text()
          if (!location) return
          next = new URL(location, next)
        }
        throw new Error('Too many sign-in redirects')
      }
      const browsing = browser()
      try {
        const outcome = await listener.outcome
        if (outcome.kind !== 'code') throw new Error('Sign-in did not supply a code')
        const session = await auth.exchange(outcome.code, pair.verifier)
        users.push(session.user.id)
        return session
      } finally {
        listener.finish({ title: 'Done', message: 'Done.' })
        try {
          await browsing
        } finally {
          listener.close()
        }
      }
    }
    const enroll = async (signer: ReturnType<typeof signingKey>, access: string) => {
      const created = await signed(signer, R.enrollments, 'POST', {
        publicKey: signer.publicKey,
        hostname: 'bee-test',
        platform: 'linux',
        arch: 'x64',
        hostVersion: '1.0.0',
      })
      expect(created.status).toBe(200)
      const enrollment = parsed(parseEnrollmentCreateResponse(await created.json()))
      const lookup = await userRequest(access, R.enrollmentLookup, 'POST', {
        userCode: enrollment.userCode,
      })
      expect(lookup.status).toBe(200)
      const details = parsed(parseEnrollmentLookupResponse(await lookup.json()))
      expect(details.keyFingerprint === enrollment.keyFingerprint).toBe(true)
      const approval = await userRequest(access, R.enrollmentApprove, 'POST', {
        userCode: enrollment.userCode,
        label: 'Bee test',
      })
      expect(approval.status).toBe(200)
      const approved = parsed(parseEnrollmentApproveResponse(await approval.json()))
      hosts.push(approved.machine.id)
      const poll = await signed(signer, R.enrollmentPoll, 'POST', {
        enrollmentId: enrollment.enrollmentId,
      })
      expect(poll.status).toBe(200)
      const status = parsed(parseEnrollmentPollResponse(await poll.json()))
      expect(status.status).toBe('approved')
      if (status.status !== 'approved') throw new Error('Not approved')
      expect(status.hostId).toBe(approved.machine.id)
      expect(status.owner.login).toBe('phosphor-e2e')
      return approved.machine.id
    }
    try {
      const a = await signIn('a')
      const b = await signIn('b')
      expect(a.user.id === b.user.id).toBe(false)
      const signer = signingKey()
      const id = await enroll(signer, a.accessToken)
      const self = await signed(signer, R.hostSelf, 'GET', undefined, id)
      expect(self.status).toBe(200)
      expect(parseHostSelfResponse(await self.json()).ok).toBe(true)
      const heartbeat = {
        seq: 1,
        state: 'running',
        hostVersion: '2.0.0',
        uptimeSec: 42,
        readiness: { pi: 'ok', claude: 'missing', tailscale: 'ok' },
        lanes: { running: 2, waiting: 1 },
        endpoint: null,
      }
      expect((await signed(signer, R.hostHeartbeat, 'POST', heartbeat, id)).status).toBe(200)
      expect((await signed(signer, R.hostHeartbeat, 'POST', heartbeat, id)).status).toBe(409)
      expect(
        (await signed(signer, R.hostHeartbeat, 'POST', { ...heartbeat, seq: 2 }, id)).status,
      ).toBe(429)
      expect(
        (
          await signed(
            signer,
            R.hostHeartbeat,
            'POST',
            { ...heartbeat, seq: 2, state: 'stopping' },
            id,
          )
        ).status,
      ).toBe(200)
      const machinesA = parsed(
        parseMachinesResponse(await (await userRequest(a.accessToken, R.machines)).json()),
      )
      expect(machinesA.machines).toHaveLength(1)
      expect(machinesA.machines[0]).toMatchObject({
        id,
        hostVersion: '2.0.0',
        state: 'stopping',
        readiness: heartbeat.readiness,
        lanes: heartbeat.lanes,
      })
      expect(machinesA.machines[0]?.lastSeenAt).not.toBeNull()
      expect(
        parsed(parseMachinesResponse(await (await userRequest(b.accessToken, R.machines)).json()))
          .machines,
      ).toHaveLength(0)
      for (const method of ['PATCH', 'DELETE'])
        expect(
          (
            await userRequest(
              b.accessToken,
              R.machines + '/' + id,
              method,
              method === 'PATCH' ? { label: 'No' } : undefined,
            )
          ).status,
        ).toBe(404)
      const renamed = await userRequest(a.accessToken, R.machines + '/' + id, 'PATCH', {
        label: 'Renamed',
      })
      expect(renamed.status).toBe(200)
      expect(parsed(parseEnrollmentApproveResponse(await renamed.json())).machine.label).toBe(
        'Renamed',
      )
      const removed = await userRequest(a.accessToken, R.machines + '/' + id, 'DELETE')
      expect(removed.status).toBe(204)
      expect(await removed.text()).toBe('')
      expect((await signed(signer, R.hostSelf, 'GET', undefined, id)).status).toBe(410)
      const second = signingKey()
      const id2 = await enroll(second, a.accessToken)
      const revoked = await signed(second, R.hostRevoke, 'POST', {}, id2)
      expect(revoked.status).toBe(204)
      expect(await revoked.text()).toBe('')
      expect((await signed(second, R.hostRevoke, 'POST', {}, id2)).status).toBe(410)
      // Two creates above, then eight more. The eleventh is limited before auth.
      for (let i = 0; i < 8; i++) {
        const fresh = signingKey()
        expect(
          (
            await signed(fresh, R.enrollments, 'POST', {
              publicKey: fresh.publicKey,
              hostname: 'limit-test',
              platform: 'linux',
              arch: 'x64',
              hostVersion: '1.0.0',
            })
          ).status,
        ).toBe(200)
      }
      expect(
        (
          await fetch(origin + R.enrollments, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(429)
      await auth.revoke(a.accessToken)
      expect(
        (await app().request(R.machines, { headers: { authorization: `Bearer ${a.accessToken}` } }))
          .status,
      ).toBe(401)
      expect(rpcCalls).toBeGreaterThan(0)
    } finally {
      try {
        for (const id of hosts) await supabase.rpc('control_host_revoke_self', { p_host_id: id })
        for (const id of enrollmentIds) {
          const deleted = await fetch(stackUrl + '/rest/v1/remote_enrollments?id=eq.' + id, {
            method: 'DELETE',
            headers: { apikey: secret },
            signal: AbortSignal.timeout(5000),
          })
          expect(deleted.ok).toBe(true)
        }
        for (const id of users) {
          const deleted = await fetch(stackUrl + '/auth/v1/admin/users/' + id, {
            method: 'DELETE',
            headers: { apikey: secret },
            signal: AbortSignal.timeout(5000),
          })
          expect(deleted.ok).toBe(true)
        }
      } finally {
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        )
      }
    }
  })
})
