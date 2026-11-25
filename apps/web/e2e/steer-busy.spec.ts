import type { Page } from '@playwright/test'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import { test, expect } from './fixture'

/** pi's own words when a plain prompt reaches it while it processes. */
const PI_BUSY =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."

type Sent = { message: string; streamingBehavior?: string }
const parse = (raw: string | Buffer): unknown => {
  try {
    return JSON.parse(raw.toString())
  } catch {
    return undefined
  }
}
type CommandFrame = { type: string; requestId: string; op?: { type: string } & Partial<Sent> }

/**
 * Keep the real Host, grant and fake pi; vary only the wire. `working` makes the
 * Host report the lane working while its chat reads idle, as background agents do.
 * `refuse` answers that plain prompt with pi's busy refusal, as when pi starts work
 * a moment before the prompt arrives. Returns every prompt the PWA sent.
 */
async function wire(page: Page, laneId: string, rules: { working?: boolean; refuse?: string }) {
  const sent: Sent[] = []
  await page.routeWebSocket('**/fixture-host', (route) => {
    const server = route.connectToServer()
    route.onMessage((raw) => {
      const frame = parse(raw) as CommandFrame | undefined
      const op = frame?.type === 'command' ? frame.op : undefined
      if (frame && op?.type === 'prompt') {
        sent.push({ message: op.message!, streamingBehavior: op.streamingBehavior })
        if (op.message === rules.refuse && !op.streamingBehavior) {
          route.send(
            JSON.stringify({
              type: 'receipt',
              receipt: {
                requestId: frame.requestId,
                status: 'failed',
                error: { code: 'pi-error', message: PI_BUSY },
              },
            }),
          )
          return
        }
      }
      server.send(raw)
    })
    server.onMessage((raw) => {
      const frame = parse(raw) as HostFrame | undefined
      if (!rules.working || (frame?.type !== 'lanes' && frame?.type !== 'lanes-delta'))
        return route.send(raw)
      const key = frame.type === 'lanes' ? 'lanes' : 'upsert'
      const lanes = frame.type === 'lanes' ? frame.lanes : frame.upsert
      route.send(
        JSON.stringify({
          ...frame,
          [key]: lanes.map((lane) =>
            lane.laneId === laneId ? { ...lane, activity: 'working' } : lane,
          ),
        }),
      )
    })
  })
  return sent
}

async function openLane(page: Page, origin: string, hostId: string, laneId: string) {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  await page.goto(`${origin}/lanes/${hostId}/${laneId}/chat`)
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  return page.getByRole('textbox', { name: 'Chat message', exact: true })
}

async function expectNoSessionError(page: Page) {
  await expect(page.getByText('Session error')).toHaveCount(0)
  await expect(page.getByText(/already processing|streamingBehavior/)).toHaveCount(0)
}

test('a Host lane its Host reports working offers Steer now and Queue follow-up, and Enter steers', async ({
  stack,
  page,
}) => {
  const sent = await wire(page, stack.laneId, { working: true })
  const chat = await openLane(page, stack.origin, stack.hostId, stack.laneId)
  await chat.fill('PHX-websteer')
  await expect(page.getByRole('button', { name: 'Steer now', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue follow-up', exact: true })).toBeVisible()
  await chat.press('Enter')
  await expect.poll(() => sent).toEqual([{ message: 'PHX-websteer', streamingBehavior: 'steer' }])
  // pi was idle, so the steer started a run and pi's echo is the bubble.
  await expect(page.getByTestId('user-message').filter({ hasText: 'PHX-websteer' })).toHaveCount(1)
  await expectNoSessionError(page)
})

test('a prompt pi refuses because it is processing goes once more as a follow-up', async ({
  stack,
  page,
}) => {
  const sent = await wire(page, stack.laneId, { refuse: 'PHX-webgap' })
  const chat = await openLane(page, stack.origin, stack.hostId, stack.laneId)
  await chat.fill('PHX-webgap')
  await chat.press('Enter')
  await expect
    .poll(() => sent)
    .toEqual([
      { message: 'PHX-webgap', streamingBehavior: undefined },
      { message: 'PHX-webgap', streamingBehavior: 'followUp' },
    ])
  await expect(page.getByTestId('user-message').filter({ hasText: 'PHX-webgap' })).toHaveCount(1)
  await expect(chat).toHaveValue('')
  await expectNoSessionError(page)
})
