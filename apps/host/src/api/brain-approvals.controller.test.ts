import { expect, it, vi } from 'vitest'
import { BRAIN_ACCESS } from '@phosphor/shared/brain-access'
import { BRAIN_APPROVAL, BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { HostCapability } from '@phosphor/shared/remote-host'
import {
  createBrainAdapter,
  type BrainSurfaceAuthority,
  type BrainSurfaceHandlers,
} from './brain-adapter'
import { bindBrainLink } from './__fixtures__/brain-link'

const ALL = BRAIN_ACCESS
const CONTROL: readonly HostCapability[] = ['sessions.control']
const send = { method: 'brain:laneSend', args: ['Who owns Harbor?', 1] }
const TURN = 'turn-harbor'
const stop = { method: 'brain:laneStop', args: [1, TURN] }
const show = { method: 'brain:laneShow', args: [] }

/** A one-controller lane: the first sender controls it; Stop needs that same controller. */
function lane() {
  let controller: { clientId: string; label: string } | null = null
  const turn = { current: TURN }
  const seen: BrainSurfaceAuthority[] = []
  const handlers = {
    'brain:laneSend': (_request: unknown, authority: BrainSurfaceAuthority) => {
      seen.push(authority)
      if (controller && controller.clientId !== authority.client.id)
        return { status: 'not-controller' }
      controller ??= { clientId: authority.client.id, label: authority.client.label }
      return { status: 'ok', data: null }
    },
    'brain:laneStop': (request: { args: [number, string] }, authority: BrainSurfaceAuthority) => {
      seen.push(authority)
      if (controller?.clientId !== authority.client.id) return { status: 'not-controller' }
      return request.args[1] === turn.current ? { status: 'ok', data: null } : { status: 'stale' }
    },
    'brain:laneShow': (_request: unknown, authority: BrainSurfaceAuthority) => {
      seen.push(authority)
      return {
        status: 'ok',
        data: {
          entries: [],
          next: null,
          dialogs: [],
          fence: 2,
          controller,
          running: false,
          turn: null,
          messaging: false,
        },
      }
    },
  } as unknown as BrainSurfaceHandlers
  return { link: createBrainAdapter(handlers), seen, turn }
}

type Link = ReturnType<typeof bindBrainLink>

/** The CLI asks, `approver` approves once, and the CLI redeems that exact request. */
async function approved(cli: Link, approver: Link, request: Record<string, unknown>, write = true) {
  const ask = await cli.run(BRAIN_SURFACE, request, write)
  if (ask.status !== 'confirm') throw new Error(`Expected approval, got ${ask.status}`)
  const answer = { action: 'answer', id: ask.confirmId, approved: true }
  expect(await approver.run(BRAIN_APPROVAL, answer, true)).toMatchObject({ status: 'ok' })
  return cli.run(BRAIN_SURFACE, request, write, {
    confirm: { confirmId: ask.confirmId, digest: ask.digest },
  })
}

const refusal = (result: OpsRunResult) =>
  result.status === 'ok' && result.data && typeof result.data === 'object'
    ? (result.data as { brainRefusal?: string }).brainRefusal
    : undefined

function people(link: ReturnType<typeof lane>['link']) {
  const rina = bindBrainLink('owner', link, ALL, undefined, [], 'Rina Okafor')
  const tom = bindBrainLink('grant-user', link, ALL, undefined, CONTROL, 'Tom Lee')
  const cli = bindBrainLink('local', link, [], undefined, [], 'Phosphor command line')
  return { rina, tom, cli }
}

it('runs an approved CLI operation as the authenticated approver, never the CLI’s own identity', async () => {
  const { link, seen } = lane()
  const { rina, cli } = people(link)
  expect(await approved(cli, rina, send)).toMatchObject({ status: 'ok', data: null })
  expect(seen[0]?.client).toEqual({ id: rina.clientId, label: 'Rina Okafor' })
  expect(seen[0]?.client.id).not.toBe(cli.clientId)
  // The page projects the controller relative to the approver the CLI acted for.
  const page = await approved(cli, rina, show, false)
  expect(page).toMatchObject({
    status: 'ok',
    data: { controller: { self: true, label: 'Rina Okafor' } },
  })
})

it('gives each redeemed request its own approver: two approvers, two controllers', async () => {
  const { link, seen } = lane()
  const { rina, tom, cli } = people(link)
  expect(await approved(cli, rina, send)).toMatchObject({ status: 'ok' })
  expect(refusal(await approved(cli, tom, send))).toBe('not-controller')
  expect(seen.map((authority) => authority.client.id)).toEqual([rina.clientId, tom.clientId])
})

it('lets another CLI stop the turn only through the controller’s own approval', async () => {
  const { link } = lane()
  const { rina, tom, cli } = people(link)
  const other = bindBrainLink('local', link, [], rina.clientId, [], 'Rina Okafor')
  expect(await approved(cli, rina, send)).toMatchObject({ status: 'ok' })
  // Claiming the controller's client id and label does not make another CLI the controller.
  expect(refusal(await approved(other, tom, stop))).toBe('not-controller')
  expect(await approved(other, rina, stop)).toMatchObject({ status: 'ok', data: null })
})

it('redeems a delayed Stop only for the turn its approver saw', async () => {
  const { link, turn } = lane()
  const { rina, cli } = people(link)
  expect(await approved(cli, rina, send)).toMatchObject({ status: 'ok' })
  const ask = await cli.run(BRAIN_SURFACE, stop, true)
  if (ask.status !== 'confirm') throw new Error('Expected approval')
  const answer = { action: 'answer', id: ask.confirmId, approved: true }
  expect(await rina.run(BRAIN_APPROVAL, answer, true)).toMatchObject({ status: 'ok' })
  // The observed turn ended and a later one runs before the CLI redeems its approval.
  turn.current = 'turn-ledger'
  const confirm = { confirmId: ask.confirmId, digest: ask.digest }
  expect(refusal(await cli.run(BRAIN_SURFACE, stop, true, { confirm }))).toBe('stale')
})

it('does not let a stop-only approver answer as the controller, nor elevate later requests', async () => {
  const { link, seen } = lane()
  const { rina, cli } = people(link)
  const stopper = bindBrainLink('grant-user', link, ['control'], undefined, CONTROL, 'Mara Voss')
  expect(await approved(cli, rina, send)).toMatchObject({ status: 'ok' })
  // Mara may approve a Stop (control alone) but acts as herself, not as Rina.
  expect(refusal(await approved(cli, stopper, stop))).toBe('not-controller')
  // Mara cannot approve a conversation request she could not make herself.
  const ask = await cli.run(BRAIN_SURFACE, send, true)
  if (ask.status !== 'confirm') throw new Error('Expected approval')
  expect(
    await stopper.run(
      BRAIN_APPROVAL,
      { action: 'answer', id: ask.confirmId, approved: true },
      true,
    ),
  ).toMatchObject({ status: 'denied' })
  // A new request with no approval runs nothing.
  expect((await cli.run(BRAIN_SURFACE, stop, true)).status).toBe('confirm')
  expect(seen.map((authority) => authority.client.label)).toEqual(['Rina Okafor', 'Mara Voss'])
})

it('revokes an approved CLI operation as soon as the approver loses authority', async () => {
  let release: (() => void) | undefined
  let admitted: boolean | undefined
  const handlers = {
    'brain:laneSend': (_request: unknown, authority: BrainSurfaceAuthority) =>
      new Promise((resolve) => {
        release = () => {
          admitted = authority.admit()
          resolve({ status: 'ok', data: null })
        }
      }),
  } as unknown as BrainSurfaceHandlers
  const link = createBrainAdapter(handlers)
  const { tom, cli } = people(link as ReturnType<typeof lane>['link'])
  const sent = approved(cli, tom, send)
  await vi.waitFor(() => expect(release).toBeDefined())
  tom.renew(ALL, [])
  release!()
  expect(admitted).toBe(false)
  expect(await sent).toMatchObject({ status: 'denied', code: 'forbidden' })
})
