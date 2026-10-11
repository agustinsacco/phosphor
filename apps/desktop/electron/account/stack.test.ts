import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, type Account } from './account'
import { AuthRefused, createGoTrue, pkcePair, type GoTrue } from './gotrue'
import { listenForCallback } from './loopback'
import { createVault, type Vault } from './vault'
import { fakeCipher } from './__fixtures__/fakes'

/**
 * The sign-in core against a real Supabase Auth: the local control stack
 * (`npm run db:start`) with GitHub played by
 * supabase/tests/fixtures/fake-github.cjs. `npm run test:auth-stack` starts
 * the fake and sets these, and fails if anything here skips; plain `npm test`
 * has no stack and skips the file.
 */
const STACK = process.env.PHOSPHOR_AUTH_STACK_URL
const KEY = process.env.PHOSPHOR_AUTH_STACK_KEY ?? ''
const GITHUB = process.env.PHOSPHOR_AUTH_STACK_GITHUB ?? ''
/** Where Supabase Auth sends the browser; published to the host as GITHUB. */
const GITHUB_IN_STACK = 'http://fake-github:54353'
const GITHUB_USER = { login: 'phosphor-e2e', name: 'Phosphor E2E', email: 'e2e@example.test' }

/**
 * The system browser: follows redirects through Supabase and the fake GitHub
 * only, until it lands on Phosphor's loopback. Not awaited by the opener, as a
 * real browser is not: the loopback holds its answer until the exchange ends.
 */
function browser() {
  const pages: Promise<string>[] = []
  async function follow(raw: string): Promise<string> {
    const loopback = new URL(new URL(raw).searchParams.get('redirect_to') ?? '').origin
    let next = new URL(raw)
    for (let hop = 0; hop < 8; hop++) {
      if (next.origin === GITHUB_IN_STACK) next.host = new URL(GITHUB).host
      if (![new URL(STACK!).origin, GITHUB, loopback].includes(next.origin)) {
        throw new Error(`the browser refused ${next.origin}`)
      }
      const response = await fetch(next, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
      const location = response.headers.get('location')
      const body = await response.text()
      if (!location) return body
      next = new URL(location, next)
    }
    throw new Error('too many redirects')
  }
  return {
    pages,
    open: async (url: string): Promise<void> => {
      pages.push(follow(url))
    },
  }
}

async function denyNext(deny: boolean): Promise<void> {
  const answer = await fetch(`${GITHUB}/__deny`, { method: 'POST', body: String(deny) })
  expect(answer.ok).toBe(true)
}

/** Who Supabase says an access token belongs to. */
async function whoIs(accessToken: string): Promise<{ status: number; id?: string }> {
  const answer = await fetch(`${STACK}/auth/v1/user`, {
    headers: { apikey: KEY, authorization: `Bearer ${accessToken}` },
  })
  const body = (await answer.json()) as { id?: string }
  return { status: answer.status, id: body.id }
}

describe.runIf(STACK)('sign-in against a real Supabase Auth with a fake GitHub', () => {
  const { cipher } = fakeCipher()
  let dir: string
  let clock = 0
  const now = (): number => Date.now() + clock
  let auth: GoTrue

  function account(vault: Vault, open = browser().open): Account {
    return createAccount({
      auth,
      vault,
      openExternal: open,
      onChange: () => {},
      log: () => {},
      now,
    })
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'phosphor-auth-stack-'))
    auth = createGoTrue({ url: STACK!, key: KEY }, fetch, now)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('signs in, remembers, refreshes across a restart and signs out for real', async () => {
    const vault = createVault(join(dir, 'account'), cipher)
    const seen = browser()
    const first = account(vault, seen.open)
    const signedIn = await first.signIn()
    expect(signedIn).toMatchObject({ status: 'signed-in', remembered: true, user: GITHUB_USER })
    if (signedIn.status !== 'signed-in') throw new Error('not signed in')
    const { id } = signedIn.user
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await seen.pages[0]).toContain('Signed in as @phosphor-e2e')

    // The access token is Supabase's own, for this user.
    const access = await first.accessToken()
    expect(await whoIs(access!)).toEqual({ status: 200, id })

    // An hour later the session refreshes, and Supabase rotates it.
    clock += 2 * 3_600_000
    const refreshed = await first.accessToken()
    expect(refreshed).not.toBe(access)
    expect(await whoIs(refreshed!)).toEqual({ status: 200, id })

    // A restart reads only the profile, then refreshes with the saved token.
    const second = account(createVault(join(dir, 'account'), cipher))
    expect(second.load()).toMatchObject({
      status: 'signed-in',
      remembered: true,
      user: GITHUB_USER,
    })
    const restarted = await second.accessToken()
    expect(await whoIs(restarted!)).toEqual({ status: 200, id })

    // Sign-out revokes the session Supabase-side: its refresh token is dead.
    const saved = vault.readToken(id)
    expect(await second.signOut()).toEqual({ status: 'signed-out' })
    expect(readdirSync(join(dir, 'account'))).toEqual([])
    await expect(auth.refresh(saved)).rejects.toMatchObject({
      name: 'AuthRefused',
      code: 'refresh_token_not_found',
    })
  })

  it("brings GitHub's refusal back as a reason, not a session", async () => {
    const seen = browser()
    await denyNext(true)
    try {
      const state = await account(createVault(join(dir, 'denied'), cipher), seen.open).signIn()
      expect(state).toMatchObject({ status: 'signed-out' })
      expect(state.status === 'signed-out' && state.error).toMatch(
        /^GitHub sign-in did not finish: \S/,
      )
      expect(await seen.pages[0]).toContain('Sign-in cancelled')
    } finally {
      await denyNext(false)
    }
  })

  it('keeps a code to its verifier and to one use, as Supabase answers it', async () => {
    const { verifier, challenge } = pkcePair()
    const listener = await listenForCallback(30_000)
    const seen = browser()
    await seen.open(auth.authorizeUrl(listener.url, challenge))
    const outcome = await listener.outcome
    if (outcome.kind !== 'code') throw new Error(`no code: ${outcome.kind}`)
    try {
      const wrong = auth.exchange(outcome.code, pkcePair().verifier)
      await expect(wrong).rejects.toBeInstanceOf(AuthRefused)
      await expect(wrong).rejects.toMatchObject({ code: 'bad_code_verifier' })
      // A wrong verifier does not burn the code; the right one still works.
      const session = await auth.exchange(outcome.code, verifier)
      expect(session.user).toMatchObject(GITHUB_USER)
      await expect(auth.exchange(outcome.code, verifier)).rejects.toMatchObject({
        name: 'AuthRefused',
        code: 'flow_state_not_found',
      })
      await auth.revoke(session.accessToken)
    } finally {
      listener.finish({ title: 'Done', message: 'Done.' })
      listener.close()
    }
    expect(await seen.pages[0]).toContain('Done')
  })
})
