import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { expect } from 'vitest'
import {
  CONTROL_ROUTES as R,
  isUuid,
  parseEnrollmentCreateResponse,
  parseEnrollmentLookupResponse,
  parseEnrollmentPollResponse,
  parseEnrollmentApproveResponse,
} from '@phosphor/shared/control-api'
import { createGoTrue, pkcePair } from '../../../../desktop/electron/account/gotrue'
import { listenForCallback } from '../../../../desktop/electron/account/loopback'
import { createApp } from '../../app'
import { parseConfig } from '../../config'
import { createSupabase } from '../../supabase'
import { RateLimiter } from '../../limits'
import type { signingKey } from '../../test-support'
import { parsed, record } from '../shared'

/** Set by tools/scripts/control-stack.mjs; absent, the stack suites are skipped. */
export const stackEnv = {
  url: process.env.PHOSPHOR_AUTH_STACK_URL,
  key: process.env.PHOSPHOR_AUTH_STACK_KEY ?? '',
  secret: process.env.PHOSPHOR_CONTROL_STACK_SECRET ?? '',
  github: process.env.PHOSPHOR_AUTH_STACK_GITHUB ?? '',
}
type Signer = ReturnType<typeof signingKey>
export type Stack = Awaited<ReturnType<typeof startStack>>

/** A control server on port 0 against the isolated stack, recording what it creates. */
export async function startStack() {
  const { url, key, secret } = stackEnv
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
    CONTROL_GRANT_KEYS: `current=${randomBytes(32).toString('base64url')}`,
  })
  const counters = { rpc: 0 }
  const recordingFetch: typeof fetch = async (input, init) => {
    if (String(input).includes('/rest/v1/rpc/')) {
      counters.rpc++
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
      version: 'stack-test',
    })
  const server = serve({ fetch: app().fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((done) => server.once('listening', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  const origin = `http://127.0.0.1:${address.port}`
  return { stackUrl, auth, users, hosts, enrollmentIds, counters, supabase, app, server, origin }
}

export function userRequest(
  stack: Stack,
  token: string,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  return fetch(stack.origin + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  })
}

export function signed(
  stack: Stack,
  signer: Signer,
  path: string,
  method: string,
  body?: unknown,
  id?: string,
) {
  const request = signer.request(method, path, body, Date.now(), id)
  return fetch(new Request(stack.origin + path, request), { signal: AbortSignal.timeout(5000) })
}

async function followSignIn(stack: Stack, start: URL, callback: string) {
  const { github } = stackEnv
  let next = start
  for (let hop = 0; hop < 8; hop++) {
    if (next.origin === 'http://fake-github:54353') next.host = new URL(github).host
    if (![stack.stackUrl, github, new URL(callback).origin].includes(next.origin))
      throw new Error('Unexpected sign-in redirect')
    const response = await fetch(next, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const location = response.headers.get('location')
    await response.text()
    if (!location) return
    next = new URL(location, next)
  }
  throw new Error('Too many sign-in redirects')
}

export async function signIn(stack: Stack, profile: 'a' | 'b') {
  const github = stackEnv.github
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
  const browsing = followSignIn(
    stack,
    new URL(stack.auth.authorizeUrl(listener.url, pair.challenge)),
    listener.url,
  )
  try {
    const outcome = await listener.outcome
    if (outcome.kind !== 'code') throw new Error('Sign-in did not supply a code')
    const session = await stack.auth.exchange(outcome.code, pair.verifier)
    stack.users.push(session.user.id)
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

export async function enroll(stack: Stack, signer: Signer, access: string) {
  const created = await signed(stack, signer, R.enrollments, 'POST', {
    publicKey: signer.publicKey,
    hostname: 'bee-test',
    platform: 'linux',
    arch: 'x64',
    hostVersion: '1.0.0',
  })
  expect(created.status).toBe(200)
  const enrollment = parsed(parseEnrollmentCreateResponse(await created.json()))
  const lookup = await userRequest(stack, access, R.enrollmentLookup, 'POST', {
    userCode: enrollment.userCode,
  })
  expect(lookup.status).toBe(200)
  const details = parsed(parseEnrollmentLookupResponse(await lookup.json()))
  expect(details.keyFingerprint === enrollment.keyFingerprint).toBe(true)
  const approval = await userRequest(stack, access, R.enrollmentApprove, 'POST', {
    userCode: enrollment.userCode,
    label: 'Bee test',
  })
  expect(approval.status).toBe(200)
  const approved = parsed(parseEnrollmentApproveResponse(await approval.json()))
  stack.hosts.push(approved.machine.id)
  const poll = await signed(stack, signer, R.enrollmentPoll, 'POST', {
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

/** Removes every Host, enrollment and user the run created, then closes the server. */
export async function stopStack(stack: Stack) {
  const { secret } = stackEnv
  const remove = async (path: string) => {
    const deleted = await fetch(stack.stackUrl + path, {
      method: 'DELETE',
      headers: { apikey: secret },
      signal: AbortSignal.timeout(5000),
    })
    expect(deleted.ok).toBe(true)
  }
  try {
    for (const id of stack.hosts)
      await stack.supabase.rpc('control_host_revoke_self', { p_host_id: id })
    for (const id of stack.enrollmentIds) await remove('/rest/v1/remote_enrollments?id=eq.' + id)
    for (const id of stack.users) await remove('/auth/v1/admin/users/' + id)
  } finally {
    await new Promise<void>((done, reject) =>
      stack.server.close((error) => (error ? reject(error) : done())),
    )
  }
}
