import { expect, test as base, type Page } from '@playwright/test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { newRoutine } from '../../../libs/shared/src/routines'
import { AGENT_POLICY_DEFAULT } from '../../../libs/shared/src/ops/policy'
import { launch, openWorkspace, shutdown, type Harness } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

const test = base.extend<{ desktop: Harness }>({
  desktop: async ({}, use, info) => {
    const root = await scratchDir('e4-')
    const at = (name: string) => join(root, name)
    for (const name of ['home', 'workspace', 'profile', 'agent', 'tmp']) await mkdir(at(name))
    try {
      const h = await launch({
        workspace: at('workspace'),
        userDataDir: at('profile'),
        agentDir: at('agent'),
        env: {
          HOME: at('home'),
          CFFIXED_USER_HOME: at('home'),
          TMPDIR: at('tmp'),
          XDG_CONFIG_HOME: at('config'),
          XDG_STATE_HOME: at('state'),
          XDG_DATA_HOME: at('data'),
          CLAUDE_CONFIG_DIR: at('claude'),
          CODEX_HOME: at('codex'),
          SHELL: '/bin/sh',
          PI_CODING_AGENT_SESSION_DIR: at('agent/sessions'),
          PHOSPHOR_ACCOUNT_NO_KEYCHAIN: '1',
          PHOSPHOR_E2E_OPS: '1',
        },
      })
      try {
        await openWorkspace(h.page)
        await use(h)
      } finally {
        if (info.status !== info.expectedStatus) {
          const log = await readFile(at('profile/logs/phosphor.log')).catch(() => null)
          if (log) await info.attach('isolated-main-log', { body: log, contentType: 'text/plain' })
        }
        await shutdown(h)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
})
const prompt = (args: string[], reason: string) => `Test op: ${JSON.stringify({ args, reason })}`
const home = (page: Page) => page.getByPlaceholder('Describe a task or ask a question')
const composer = (page: Page) => page.getByPlaceholder(/Describe a task…/i)
async function start(page: Page, text: string) {
  await home(page).fill(text)
  await page.getByRole('button', { name: /Start lane/i }).click()
}
async function askForPins(page: Page) {
  const result = await page.evaluate(
    (policy) =>
      window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'policy.set', args: { policy } }),
    { ...AGENT_POLICY_DEFAULT, ops: { 'lane.pin': 'ask' } },
  )
  expect(result.status).toBe('ok')
}
const pins = (page: Page) =>
  page.evaluate(async () => (await window.phosphor.invoke('app:getPrefs')).pinnedSessions)

test('Swarm reports one agent notice and honors a subsequent user off', async ({
  desktop: { page },
}) => {
  const text = prompt(['swarm.on'], 'Review in parallel')
  await start(page, text)
  const toggle = page.getByRole('switch', { name: 'Swarm' })
  const notices = page.getByTestId('toast-stack')
  await expect(
    notices.getByText('Agent turned on Swarm: Review in parallel.', { exact: true }),
  ).toBeVisible()
  await expect(notices.getByText(/Agent (turned on Swarm|ran swarm\.on)/)).toHaveCount(1)
  await expect(toggle).toBeChecked()
  await expect(toggle.getByText('agent', { exact: true })).toBeVisible()
  await expect(toggle).toHaveAccessibleDescription(/The agent turned Swarm on: Review in parallel/)
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await composer(page).fill(text)
  await composer(page).press('Enter')
  await expect(
    page.getByText('The user turned Swarm off for this lane. Ask them to turn it on.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(toggle).not.toBeChecked()
})

test('deny and approve a policy-asked pin, then Undo its audited change in Settings', async ({
  desktop: { page },
}) => {
  await askForPins(page)
  const text = prompt(['lane.pin', 'on'], 'Keep this review handy')
  await start(page, text)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Keep this review handy')
  expect(await pins(page)).toEqual([])
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByText('Not approved.', { exact: true })).toBeVisible()
  expect(await pins(page)).toEqual([])
  await composer(page).fill(text)
  await composer(page).press('Enter')
  await expect(dialog).toContainText('lane.pin')
  expect(await pins(page)).toEqual([])
  await dialog.getByRole('button', { name: 'Approve' }).click()
  await expect.poll(() => pins(page)).toHaveLength(1)
  await page
    .getByTestId('account-footer')
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Agent', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Agent changes on this machine' })).toBeVisible()
  const row = dialog.getByRole('listitem').filter({ hasText: 'lane › pin · approved' })
  await expect(row).toContainText('Keep this review handy')
  await row.getByRole('button', { name: 'Undo' }).click()
  await expect(row).toContainText('Undone by')
  expect(await pins(page)).toEqual([])
})

test('a routine receives the unattended refusal and finishes without a dialog', async ({
  desktop: { page, workspace },
}) => {
  await askForPins(page)
  const input = {
    ...newRoutine(workspace),
    name: 'Unattended review',
    instructions: prompt(['lane.pin', 'on'], 'Keep the report'),
    isolated: false,
    provider: 'stub',
    model: 'stub-model',
    trusted: true,
  }
  await page.evaluate(async (routine) => {
    await window.phosphor.invoke('routines:save', routine)
    const { routines } = await window.phosphor.invoke('routines:list')
    await window.phosphor.invoke('routines:run', routines[0]!.id, 'run-once')
  }, input)
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await window.phosphor.invoke('routines:list')).runs.map((r) => r.status),
        ),
      { timeout: 30000 },
    )
    .toEqual(['finished'])
  const audit = await page.evaluate(() =>
    window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'audit.list', args: {} }),
  )
  expect(audit).toMatchObject({
    status: 'ok',
    data: expect.arrayContaining([
      expect.objectContaining({ op: 'lane.pin', decision: 'denied-unattended' }),
    ]),
  })
  expect(await pins(page)).toEqual([])
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('model chip changes only after agent_settled', async ({ desktop: { page } }) => {
  await start(page, prompt(['model.set', 'openai/gpt-5'], 'Compare the result'))
  await expect(
    page.getByText('Queued model for after this run.', { exact: false }).last(),
  ).toBeVisible()
  const chip = page.getByTestId('model-chip')
  await expect(chip).toContainText('Stub Model')
  await page.evaluate(async () => {
    const [lane] = await window.phosphor.invoke('pi:listLiveSessions')
    await window.phosphor.piCommand(lane!.sessionId, { type: 'prompt', message: '/stub-op-settle' })
  })
  await expect(chip).toContainText('GPT-5')
})

test('select a local @lane, send the chip, and open the referenced conversation', async ({
  desktop: { page },
}) => {
  await start(page, 'speclink')
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: /^New$/ }).click()
  await home(page).fill('See @Stub')
  await expect(page.getByText('Lanes', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: /^Stub Session Title This / }).click()
  await expect(home(page)).toHaveValue(
    /\[@Stub Session Title\]\(phosphor-lane:local\/session:[\w-]+\)/,
  )
  await home(page).press('Enter')
  const chip = page.getByTestId('user-message').getByRole('button', { name: '@Stub Session Title' })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(
    page.getByTestId('user-message').getByText('speclink', { exact: true }),
  ).toBeVisible()
})
