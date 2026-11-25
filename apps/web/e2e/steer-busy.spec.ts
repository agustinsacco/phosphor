import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import { test, expect } from './fixture'

type Sent = { message: string; streamingBehavior?: string }
type Captured = Sent & { requestId: string }
const parse = (raw: string | Buffer): unknown => {
  try {
    return JSON.parse(raw.toString())
  } catch {
    return undefined
  }
}
type CommandFrame = { type: string; requestId: string; op?: { type: string } & Partial<Sent> }

/** Observe real Host commands; only the first test overrides the lane's activity. */
async function wire(page: Page, laneId: string, working = false) {
  const sent: Captured[] = []
  await page.routeWebSocket('**/fixture-host', (route) => {
    const server = route.connectToServer()
    route.onMessage((raw) => {
      const frame = parse(raw) as CommandFrame | undefined
      const op = frame?.type === 'command' ? frame.op : undefined
      if (frame && op?.type === 'prompt')
        sent.push({
          requestId: frame.requestId,
          message: op.message!,
          streamingBehavior: op.streamingBehavior,
        })
      server.send(raw)
    })
    server.onMessage((raw) => {
      const frame = parse(raw) as HostFrame | undefined
      if (!working || (frame?.type !== 'lanes' && frame?.type !== 'lanes-delta'))
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
  const sent = await wire(page, stack.laneId, true)
  const chat = await openLane(page, stack.origin, stack.hostId, stack.laneId)
  await chat.fill('PHX-websteer')
  await expect(page.getByRole('button', { name: 'Steer now', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue follow-up', exact: true })).toBeVisible()
  await chat.press('Enter')
  await expect
    .poll(() => sent)
    .toMatchObject([{ message: 'PHX-websteer', streamingBehavior: 'steer' }])
  // pi was idle, so the steer started a run and pi's echo is the bubble.
  await expect(page.getByTestId('user-message').filter({ hasText: 'PHX-websteer' })).toHaveCount(1)
  await expectNoSessionError(page)
})

test('a follow-up has one Host request, then a queue chip and a single transcript echo', async ({
  stack,
  page,
}) => {
  const sent = await wire(page, stack.laneId)
  const chat = await openLane(page, stack.origin, stack.hostId, stack.laneId)
  const release = join(stack.repository, 'release-steer-busy')
  const first = `slow-until ${release}`
  await chat.fill(first)
  await chat.press('Enter')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  const message = 'PHX-webfollowup'
  await chat.fill(message)
  await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click()
  const chip = page.getByTestId('queue-chips').getByText(message, { exact: true })
  const echo = page.getByTestId('user-message').filter({ hasText: message })
  await expect(chip).toHaveCount(1)
  await expect(echo).toHaveCount(0)
  await expect(chat).toHaveValue('')
  await writeFile(release, '')
  await expect(chip).toHaveCount(0)
  await expect(echo).toHaveCount(1)
  await expect(stop).toBeHidden()
  await expect(chat).toHaveAttribute('placeholder', 'Describe a task…')
  await chat.fill('PHX-webidle')
  await chat.press('Enter')
  await expect(page.getByTestId('user-message').filter({ hasText: 'PHX-webidle' })).toHaveCount(1)
  expect(sent).toMatchObject([
    { message: first, streamingBehavior: 'followUp' },
    { message, streamingBehavior: 'followUp' },
    { message: 'PHX-webidle', streamingBehavior: 'followUp' },
  ])
  expect(new Set(sent.map((prompt) => prompt.requestId)).size).toBe(3)
  await expectNoSessionError(page)
})
