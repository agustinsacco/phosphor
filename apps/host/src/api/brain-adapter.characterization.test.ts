import { expect, it } from 'vitest'
import { BRAIN_ACCESS } from '@phosphor/shared/brain-access'
import { BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import { createBrainAdapter, type BrainSurfaceHandlers } from './brain-adapter'
import { bindBrainLink } from './__fixtures__/brain-link'

const status = { method: 'brain:status', args: [] }
const tell = { method: 'brain:tell', args: ['Rina Okafor owns Harbor'] }
const ALL = BRAIN_ACCESS
const CONTROL = ['sessions.control'] as const

/** Handlers that hold every `brain:tell` until the test releases them all. */
function held() {
  const releases: (() => void)[] = []
  const handlers = {
    'brain:tell': () =>
      new Promise((resolve) => releases.push(() => resolve({ status: 'ok', data: null }))),
  } as unknown as BrainSurfaceHandlers
  return { adapter: createBrainAdapter(handlers), releases }
}

it('refuses everything as unsupported when the Host serves no Brain', async () => {
  const owner = bindBrainLink('owner', createBrainAdapter(), ALL)
  expect(await owner.run(BRAIN_SURFACE, status)).toMatchObject({
    status: 'denied',
    code: 'unsupported',
  })
})

it('refuses batches, reasons, pages, a mismatched read/write and an owner confirm', async () => {
  const owner = bindBrainLink('owner', held().adapter, ALL)
  for (const extra of [{ batch: [] }, { reason: 'Kestrel' }, { page: { cursor: null } }])
    expect(await owner.run(BRAIN_SURFACE, tell, true, extra)).toMatchObject({
      status: 'denied',
      code: 'bad-request',
    })
  expect(await owner.run(BRAIN_SURFACE, tell, false)).toMatchObject({ code: 'bad-request' })
  const confirm = { confirmId: '6513c7c5-866b-4df8-b991-69897e1d0234', digest: 'd' }
  expect(await owner.run(BRAIN_SURFACE, tell, true, { confirm })).toMatchObject({
    code: 'forbidden',
  })
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// The link fixture keeps one pending reply per connection: concurrent replies are not awaited.
it('answers busy past four requests in flight on one connection, and frees them as they finish', async () => {
  const { adapter, releases } = held()
  const owner = bindBrainLink('grant-user', adapter, ALL, undefined, CONTROL)
  for (let i = 0; i < 4; i++) void owner.run(BRAIN_SURFACE, tell, true)
  await tick()
  expect(releases).toHaveLength(4)
  expect(await owner.run(BRAIN_SURFACE, tell, true)).toMatchObject({
    status: 'denied',
    code: 'busy',
  })
  for (const release of releases.splice(0)) release()
  await tick()
  const again = owner.run(BRAIN_SURFACE, tell, true)
  await tick()
  releases.at(-1)!()
  expect(await again).toMatchObject({ status: 'ok' })
})

it('answers busy past 32 requests in flight across connections', async () => {
  const { adapter, releases } = held()
  const people = Array.from({ length: 9 }, () =>
    bindBrainLink('grant-user', adapter, ALL, undefined, CONTROL),
  )
  for (const p of people.slice(0, 8))
    for (let i = 0; i < 4; i++) void p.run(BRAIN_SURFACE, tell, true)
  await tick()
  expect(releases).toHaveLength(32)
  expect(await people[8]!.run(BRAIN_SURFACE, tell, true)).toMatchObject({ code: 'busy' })
  for (const release of releases.splice(0)) release()
})

it('refuses a connection after it closes', async () => {
  const owner = bindBrainLink('grant-user', held().adapter, ALL, undefined, CONTROL)
  owner.close()
  let answered = false
  void owner.run(BRAIN_SURFACE, tell, true).then(() => {
    answered = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  // A closed connection gets no reply at all.
  expect(answered).toBe(false)
})
