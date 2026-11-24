import { describe, expect, it } from 'vitest'
import {
  createControlLink,
  EnrollmentRefused,
  LINK_RECHECK_MS,
  type ControlLinkPorts,
  type EnrollmentOffer,
  type LinkEnrollment,
  type LinkSession,
} from './link'

const enrollment = (hostId: string): LinkEnrollment => ({
  identity: { hostId, label: 'bee1', ownerLogin: 'me' },
})
const offer: EnrollmentOffer = {
  userCode: 'ABCD2345',
  fingerprint: 'SHA256:x',
  expiresAt: '2026-11-23T00:10:00.000Z',
}

/** A heartbeat the test ends: `gone()` answers 410, `drain()` ends it cleanly. */
function fakeSession() {
  let end: (code: number) => void = () => {}
  const ended = new Promise<number>((resolve) => {
    end = resolve
  })
  const session: LinkSession = {
    run: () => ended,
    drain: async () => {
      end(0)
      return { state: 'stopped' }
    },
  }
  return { session, gone: () => end(77) }
}

function harness(options: { local: boolean; initial?: LinkEnrollment | null }) {
  const events: string[] = []
  const sessions: ReturnType<typeof fakeSession>[] = []
  const waits: { ms: number; resolve: () => void }[] = []
  let saved: LinkEnrollment | null = options.initial ?? null
  let enroll: ControlLinkPorts<LinkEnrollment>['enroll']
  const ports: ControlLinkPorts<LinkEnrollment> = {
    local: options.local,
    load: async () => saved,
    connect: (found) => {
      events.push(`connect:${found.identity.hostId}`)
      const fake = fakeSession()
      sessions.push(fake)
      return fake.session
    },
    disconnect: async () => {
      events.push('disconnect')
    },
    enroll: (signal, give) => (enroll ? enroll(signal, give) : Promise.resolve()),
    now: () => 0,
    wait: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        waits.push({ ms, resolve })
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    log: (event) => events.push(event),
  }
  const link = createControlLink(ports, options.initial ?? null)
  return {
    link,
    events,
    sessions,
    waits,
    save: (value: LinkEnrollment | null) => {
      saved = value
    },
    onEnroll: (value: typeof enroll) => {
      enroll = value
    },
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('control link transitions', () => {
  it('enrolled, 410 without the marker: run ends 77 and nothing disconnects', async () => {
    const h = harness({ local: false, initial: enrollment('a') })
    h.link.start()
    const run = h.link.run()
    h.sessions[0]?.gone()
    expect(await run).toBe(77)
    expect(h.events).toEqual(['connect:a', 'control.enrolled'])
  })

  it('enrolled, 410 with the marker: removed, TCP disconnected, run keeps going until drained', async () => {
    const h = harness({ local: true, initial: enrollment('a') })
    h.link.start()
    const run = h.link.run()
    h.sessions[0]?.gone()
    await settle()
    expect(h.link.state()).toMatchObject({ kind: 'removed', hostId: 'a' })
    expect(h.events).toEqual(['connect:a', 'control.enrolled', 'control.removed', 'disconnect'])
    await h.link.drain()
    expect(await run).toBe(0)
  })

  it('local: an identity that appears is connected on reload, without a restart', async () => {
    const h = harness({ local: true })
    h.link.start()
    const run = h.link.run()
    expect(h.link.mode()).toBe('local')
    await h.link.reload()
    expect(h.link.mode()).toBe('local')
    h.save(enrollment('b'))
    await h.link.reload()
    expect(h.link.state()).toEqual({
      kind: 'enrolled',
      hostId: 'b',
      label: 'bee1',
      ownerLogin: 'me',
    })
    await h.link.drain()
    expect(await run).toBe(0)
  })

  it(`local: re-reads the identity every ${LINK_RECHECK_MS} ms`, async () => {
    const h = harness({ local: true })
    h.link.start()
    const run = h.link.run()
    await settle()
    expect(h.waits.map((wait) => wait.ms)).toEqual([LINK_RECHECK_MS])
    h.save(enrollment('c'))
    h.waits[0]?.resolve()
    await settle()
    expect(h.link.mode()).toBe('enrolled')
    await h.link.drain()
    expect(await run).toBe(0)
  })

  it('removed: the same identity stays removed, a new one enrolls', async () => {
    const h = harness({ local: true, initial: enrollment('a') })
    h.link.start()
    const run = h.link.run()
    h.sessions[0]?.gone()
    await settle()
    await h.link.reload()
    expect(h.link.mode()).toBe('removed')
    h.save(enrollment('d'))
    await h.link.reload()
    expect(h.link.state()).toMatchObject({ kind: 'enrolled', hostId: 'd' })
    await h.link.drain()
    expect(await run).toBe(0)
  })

  it('drain with no heartbeat stops at once and run ends 0', async () => {
    const h = harness({ local: true })
    h.link.start()
    const run = h.link.run()
    expect(await h.link.drain()).toEqual({ state: 'stopped' })
    expect(await run).toBe(0)
    expect(h.link.exitCode()).toBe(0)
  })
})

describe('in-process enrollment', () => {
  it('is refused while enrolled: a machine never re-enrolls (N13)', async () => {
    const h = harness({ local: true, initial: enrollment('a') })
    h.link.start()
    await expect(h.link.beginEnrollment()).rejects.toMatchObject({ reason: 'enrolled' })
    await expect(h.link.beginEnrollment()).rejects.toBeInstanceOf(EnrollmentRefused)
  })

  it('offers a code at once, repeats it, and enrolls on approval without a restart', async () => {
    const h = harness({ local: true })
    let approve: () => void = () => {}
    h.onEnroll(async (_signal, give) => {
      give(offer)
      await new Promise<void>((resolve) => {
        approve = resolve
      })
      h.save(enrollment('e'))
    })
    h.link.start()
    const run = h.link.run()
    expect(await h.link.beginEnrollment()).toEqual(offer)
    expect(h.link.state()).toEqual({ kind: 'enrolling', offer })
    expect(await h.link.beginEnrollment()).toEqual(offer)
    approve()
    await settle()
    await settle()
    expect(h.link.state()).toMatchObject({ kind: 'enrolled', hostId: 'e' })
    await h.link.drain()
    expect(await run).toBe(0)
  })

  it('cancel returns to the previous state', async () => {
    const h = harness({ local: true })
    h.onEnroll(async (signal, give) => {
      give(offer)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    })
    h.link.start()
    await h.link.beginEnrollment()
    await h.link.cancelEnrollment()
    expect(h.link.mode()).toBe('local')
  })

  it('an enrollment that fails before its code rejects with the cause', async () => {
    const h = harness({ local: true })
    h.onEnroll(async () => {
      throw new Error('control offline')
    })
    h.link.start()
    await expect(h.link.beginEnrollment()).rejects.toThrow('control offline')
    expect(h.link.mode()).toBe('local')
  })
})
