import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ROUTES,
  CONTROL_ERROR_STATUS,
  type ControlErrorCode,
} from '@phosphor/shared/control-api'
import {
  controlMachine,
  hostId,
  oldIdentity,
  type ControlMachine,
} from '../control/__fixtures__/machine'
import { identityDirectory, type PendingEnrollment } from '../control/identity'
import { freshKey, publicIdentity } from '../control/signer'
import { runLogin } from './login'

let machine: ControlMachine
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  machine = await controlMachine()
})
afterEach(async () => {
  try {
    expect(console.log).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    await machine.cleanup()
  }
})

async function pendingEnrollment(overrides: Partial<PendingEnrollment> = {}) {
  const key = freshKey()
  const enrollment: PendingEnrollment = {
    version: 1,
    controlUrl: 'https://example.com',
    enrollmentId: hostId,
    userCode: 'BCDFGHJK',
    keyFingerprint: publicIdentity(key).keyFingerprint,
    expiresAt: '2026-10-10T00:10:00.000Z',
    savedAt: '2026-10-10T00:00:00.000Z',
    pollIntervalSec: 5,
    ...overrides,
  }
  await machine.store.savePending(enrollment, key)
  return { enrollment, key }
}

describe('phosphor login', () => {
  it('prints the code and actual key fingerprint, respects the interval and commits only after approval', async () => {
    let waits = 0
    machine.onWait(async () => {
      expect(await machine.store.load()).toBeNull()
      if (++waits === 1) machine.setAnswer({ status: 'pending' })
      else machine.setAnswer({ status: 'approved', hostId, label: 'bee1', owner: { login: 'me' } })
    })
    expect(await runLogin(machine.context)).toEqual({
      exitCode: 0,
      message: 'This machine is now "bee1" on @me\'s account.',
    })
    expect(machine.waits).toEqual([5000, 5000])
    const loaded = await machine.store.load()
    expect(loaded?.identity).toEqual({
      version: 1,
      controlUrl: 'https://example.com',
      hostId,
      label: 'bee1',
      ownerLogin: 'me',
      savedAt: '2026-10-10T00:00:10.000Z',
    })
    expect(machine.output.join('\n')).toContain('BCDF-GHJK')
    expect(machine.output.join('\n')).toContain(loaded && publicIdentity(loaded.key).keyFingerprint)
    expect(machine.calls.map((call) => call.path)).toEqual([
      CONTROL_ROUTES.enrollments,
      CONTROL_ROUTES.enrollmentPoll,
      CONTROL_ROUTES.enrollmentPoll,
      CONTROL_ROUTES.hostSelf,
    ])
    const pem = await readFile(
      join(identityDirectory(machine.configPath), `host-key.${hostId}.pem`),
      'utf8',
    )
    const output = [...machine.output, (await runLogin(machine.context)).message].join('\n')
    expect(output).not.toContain(pem)
    expect(output).not.toContain('PRIVATE KEY')
    for (const call of machine.calls) {
      expect(output).not.toContain(call.headers.get('x-phosphor-signature'))
      expect(output).not.toContain('x-phosphor-')
    }
  })
  it('returns without writes when already enrolled and confirmed', async () => {
    await machine.enrollOld()
    const before = await machine.store.load()
    expect((await runLogin(machine.context)).exitCode).toBe(0)
    expect(machine.calls.map((call) => call.method)).toEqual(['GET'])
    expect((await machine.store.load())?.identity).toEqual(before?.identity)
  })
  it.each(['cancelled', 'expired', 'deadline'])(
    'leaves the old identity and key untouched when %s',
    async (outcome) => {
      await machine.enrollOld()
      machine.setMode('gone')
      const old = await machine.store.load()
      if (outcome === 'cancelled')
        machine.onWait(() => {
          machine.abort.abort()
        })
      if (outcome === 'expired') machine.setAnswer({ status: 'expired' })
      if (outcome === 'deadline') {
        machine.setAnswer({ status: 'pending' })
        machine.setCreation({ expiresAt: '2026-10-10T00:00:05.000Z' })
      }
      const result = await runLogin(machine.context)
      expect(result.exitCode).toBe(outcome === 'cancelled' ? 130 : 75)
      if (outcome !== 'cancelled')
        expect(result.message).toBe('The code expired. Run phosphor login again.')
      const retained = await machine.store.load()
      expect(retained?.identity).toEqual(oldIdentity)
      expect(retained && publicIdentity(retained.key)).toEqual(old && publicIdentity(old.key))
    },
  )
  it('starts fresh after gone and replaces only once approved', async () => {
    await machine.enrollOld()
    machine.setMode('gone')
    machine.onWait(async () => {
      expect((await machine.store.load())?.identity).toEqual(oldIdentity)
    })
    expect((await runLogin(machine.context)).exitCode).toBe(0)
    expect(machine.output[0]).toContain('removed from the account')
    expect((await machine.store.load())?.identity.hostId).toBe(hostId)
  })
  it.each(['offline', 'unavailable'] as const)(
    'keeps an approved identity if confirmation is %s',
    async (mode) => {
      machine.setFinalMode(mode)
      const result = await runLogin(machine.context)
      expect(result.exitCode).toBe(0)
      expect(result.message).toContain(
        'Saved. Phosphor could not confirm it yet; phosphor status will check again.',
      )
      expect((await machine.store.load())?.identity.hostId).toBe(hostId)
    },
  )
  it('deletes a newly saved identity and exits 77 when final confirmation says gone', async () => {
    machine.setFinalMode('gone')
    expect((await runLogin(machine.context)).exitCode).toBe(77)
    expect(await machine.store.load()).toBeNull()
  })
  it.each(['offline', 'unavailable'] as const)(
    'fails without a new enrollment when the earlier self check is %s',
    async (mode) => {
      await machine.enrollOld()
      machine.setMode(mode)
      expect((await runLogin(machine.context)).exitCode).toBe(75)
      expect(machine.calls.map((call) => call.path)).toEqual([CONTROL_ROUTES.hostSelf])
    },
  )
  it('does not save malformed approvals or mismatched fingerprints', async () => {
    machine.setAnswer({ status: 'approved', hostId: 'bad', label: 'bee1', owner: { login: 'me' } })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(await machine.store.load()).toBeNull()
    machine.setCreation({ keyFingerprint: '0000-0000-0000-0000' })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(await machine.store.load()).toBeNull()
  })
  it('recovers an incomplete key, but refuses an origin mismatch before either origin is contacted', async () => {
    await machine.enrollOld()
    await writeFile(
      join(identityDirectory(machine.configPath), `host-key.${oldIdentity.hostId}.pem`),
      'invalid',
    )
    await writeFile(
      machine.configPath,
      JSON.stringify({ ...machine.config, control: { url: 'https://other.example' } }),
    )
    const result = await runLogin(machine.context)
    expect(result.exitCode).toBe(78)
    expect(result.message).toContain('Run phosphor logout --local, then phosphor login.')
    expect(machine.calls).toEqual([])
    await writeFile(machine.configPath, JSON.stringify(machine.config))
    expect((await runLogin(machine.context)).exitCode).toBe(0)
  })
  it('bounds pending enrollment even when the server clock or expiry is far ahead', async () => {
    machine.setAnswer({ status: 'pending' })
    machine.setCreation({ expiresAt: '2099-10-10T00:00:00.000Z', pollIntervalSec: 60 })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(machine.waits.reduce((total, ms) => total + ms, 0)).toBe(600_000)
    expect(machine.polls()).toBe(9)
    expect(await machine.store.load()).toBeNull()
  })
  it('refuses a concurrent login with exit 75 and leaves the live identity lock untouched', async () => {
    let second: Awaited<ReturnType<typeof runLogin>> | undefined
    machine.onWait(async () => {
      const directory = identityDirectory(machine.configPath)
      const before = await readdir(directory)
      const lock = await readFile(join(directory, '.lock'), 'utf8')
      second = await runLogin(machine.context)
      expect(await readdir(directory)).toEqual(before)
      expect(await readFile(join(directory, '.lock'), 'utf8')).toBe(lock)
    })
    expect((await runLogin(machine.context)).exitCode).toBe(0)
    expect(second).toMatchObject({ exitCode: 75, message: expect.stringContaining('running (pid') })
    expect(machine.calls.filter((call) => call.path === CONTROL_ROUTES.enrollments)).toHaveLength(1)
  })
  it.each([false, true])(
    'recovers approval using the pending key with an orphan key file: %s',
    async (orphan) => {
      const { key } = await pendingEnrollment({ pollIntervalSec: 7 })
      if (orphan)
        await writeFile(
          join(identityDirectory(machine.configPath), `host-key.${hostId}.pem`),
          key.export({ type: 'pkcs8', format: 'pem' }),
          { mode: 0o600 },
        )
      expect((await runLogin(machine.context)).exitCode).toBe(0)
      expect(machine.waits).toEqual([7000])
      expect(machine.calls.map((call) => call.path)).toEqual([
        CONTROL_ROUTES.enrollmentPoll,
        CONTROL_ROUTES.hostSelf,
      ])
      const loaded = await machine.store.load()
      if (!loaded) throw new Error('Expected a committed identity')
      expect(publicIdentity(loaded.key)).toEqual(publicIdentity(key))
      expect(await machine.store.loadPending()).toBeNull()
      expect(await readdir(identityDirectory(machine.configPath))).not.toContain('pending-key.pem')
      expect(machine.output.join('\n')).toContain('Resuming the earlier request.')
    },
  )
  it('refuses an orphan key with different public bytes', async () => {
    const { key } = await pendingEnrollment()
    await writeFile(
      join(identityDirectory(machine.configPath), `host-key.${hostId}.pem`),
      freshKey().export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    )
    expect((await runLogin(machine.context)).exitCode).toBe(78)
    expect(await machine.store.load()).toBeNull()
    const pending = await machine.store.loadPending()
    if (!pending) throw new Error('Expected a pending enrollment')
    expect(publicIdentity(pending.key)).toEqual(publicIdentity(key))
  })
  it('keeps pending files on Ctrl-C, then resumes the same code and key without enrolling', async () => {
    machine.onWait(async () => {
      expect(await machine.store.loadPending()).not.toBeNull()
      machine.abort.abort()
    })
    const result = await runLogin(machine.context)
    expect(result).toEqual({
      exitCode: 130,
      message: "Cancelled. Run phosphor login again within the code's lifetime to keep waiting.",
    })
    const pending = await machine.store.loadPending()
    machine.onWait(undefined)
    expect(
      (await runLogin({ ...machine.context, signal: new AbortController().signal })).exitCode,
    ).toBe(0)
    expect(machine.calls.filter((call) => call.path === CONTROL_ROUTES.enrollments)).toHaveLength(1)
    const loaded = await machine.store.load()
    if (!loaded || !pending) throw new Error('Expected pending and committed state')
    expect(publicIdentity(loaded.key)).toEqual(publicIdentity(pending.key))
    expect(machine.output.join('\n')).toContain('Resuming the earlier request.')
  })
  it.each(['expired', 'other-origin', 'fingerprint'])(
    'discards %s pending files before creating a fresh enrollment',
    async (kind) => {
      const { enrollment, key } = await pendingEnrollment(
        kind === 'expired'
          ? { expiresAt: '2026-10-10T00:00:00.000Z' }
          : kind === 'other-origin'
            ? { controlUrl: 'https://other.example' }
            : {},
      )
      if (kind === 'fingerprint')
        await writeFile(
          join(identityDirectory(machine.configPath), 'pending.json'),
          JSON.stringify({
            ...enrollment,
            keyFingerprint: publicIdentity(freshKey()).keyFingerprint,
          }),
        )
      const fetcher = machine.context.fetch
      machine.context.fetch = async (url, init) => {
        if (String(url).endsWith(CONTROL_ROUTES.enrollments)) {
          expect(await machine.store.loadPending()).toBeNull()
          expect(await readdir(identityDirectory(machine.configPath))).not.toContain(
            'pending-key.pem',
          )
        }
        if (!fetcher) throw new Error('missing fake transport')
        return fetcher(url, init)
      }
      expect((await runLogin(machine.context)).exitCode).toBe(0)
      expect(machine.calls.some((call) => call.path === CONTROL_ROUTES.enrollments)).toBe(true)
      const loaded = await machine.store.load()
      if (!loaded) throw new Error('Expected a committed identity')
      expect(publicIdentity(loaded.key)).not.toEqual(publicIdentity(key))
    },
  )
  it.each([429, 503, 502, 500, 0])(
    'retries transient polling status %s, resets backoff and prints once per streak',
    async (status) => {
      const fetcher = machine.context.fetch
      let polls = 0
      machine.context.fetch = async (url, init) => {
        if (String(url).endsWith(CONTROL_ROUTES.enrollmentPoll)) {
          polls++
          if (polls === 1 || polls === 2 || polls === 4) {
            if (status === 0) throw new Error('private transport detail')
            if (status === 502) return new Response('<html>private edge detail</html>', { status })
            const code =
              status === 429 ? 'too-many-requests' : status === 500 ? 'internal' : 'unavailable'
            return Response.json({ error: { code, message: 'private server detail' } }, { status })
          }
          if (polls === 3) return Response.json({ status: 'pending' })
        }
        if (!fetcher) throw new Error('missing fake transport')
        return fetcher(url, init)
      }
      expect((await runLogin(machine.context)).exitCode).toBe(0)
      expect(machine.waits).toEqual([5000, 10000, 20000, 5000, 10000])
      expect(
        machine.output.filter((line) => line.startsWith('The control plane is not answering')),
      ).toHaveLength(2)
      expect(machine.output.join('\n')).not.toContain('private')
    },
  )
  it('bounds exponential backoff at 30 seconds and never waits past the deadline, retaining pending', async () => {
    await pendingEnrollment({ expiresAt: '2026-10-10T00:01:40.000Z' })
    machine.context.fetch = async () => new Response('edge failure', { status: 503 })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(machine.waits).toEqual([5000, 10000, 20000, 30000, 30000, 5000])
    expect(await machine.store.loadPending()).not.toBeNull()
    expect(
      machine.output.filter((line) => line.startsWith('The control plane is not answering')),
    ).toHaveLength(1)
  })
  it.each<ControlErrorCode>([
    'gone',
    'not-found',
    'forbidden',
    'bad-request',
    'unauthenticated',
    'conflict',
    'payload-too-large',
    'unsupported-media-type',
  ])('never retries %s', async (code) => {
    await pendingEnrollment()
    let polls = 0
    machine.context.fetch = async () => {
      polls++
      return Response.json(
        { error: { code, message: 'private' } },
        { status: CONTROL_ERROR_STATUS[code] },
      )
    }
    expect((await runLogin(machine.context)).exitCode).toBe(code === 'gone' ? 77 : 75)
    expect(polls).toBe(1)
    expect(machine.waits).toEqual([5000])
    expect(await machine.store.loadPending()).toEqual(
      ['gone', 'not-found', 'forbidden'].includes(code) ? null : expect.any(Object),
    )
  })
  it('removes leftover pending state on a confirmed committed identity and on server expiry', async () => {
    await pendingEnrollment()
    await machine.enrollOld()
    expect((await runLogin(machine.context)).exitCode).toBe(0)
    expect(await machine.store.loadPending()).toBeNull()
    await machine.store.remove()
    await pendingEnrollment()
    machine.setAnswer({ status: 'expired' })
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(await machine.store.loadPending()).toBeNull()
  })
  it('does not retry enrollment itself or print a code before pending files commit', async () => {
    let calls = 0
    machine.context.fetch = async () => {
      calls++
      return new Response('edge failure', { status: 503 })
    }
    expect((await runLogin(machine.context)).exitCode).toBe(75)
    expect(calls).toBe(1)
    expect(machine.waits).toEqual([])
    expect(machine.output).toEqual([])
    expect(await machine.store.loadPending()).toBeNull()
  })

  it('commits pending before printing any approval instruction', async () => {
    const original = machine.store.savePending
    let completed = false
    let saving = Promise.resolve()
    const save = vi.spyOn(machine.store, 'savePending').mockImplementation((...args) => {
      saving = original(...args).then(() => {
        completed = true
      })
      return saving
    })
    const print = vi.fn((line: string) => {
      expect(completed).toBe(true)
      machine.context.print(line)
    })
    const result = await runLogin({ ...machine.context, print })
    await saving
    expect(result.exitCode).toBe(0)
    expect(save).toHaveBeenCalledOnce()
  })
})
