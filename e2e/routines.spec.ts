import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { newRoutine, type RoutineInput } from '../shared/routines'
import type * as Sqlite from 'node:sqlite'
import type * as NodePath from 'node:path'

const root = resolve(import.meta.dirname, '..')
let app: ElectronApplication
let page: Page
let directory: string
let workspace: string
let profile: string

async function launch(): Promise<void> {
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_CLI_ARGS
  delete env.NODE_ENV_ELECTRON_VITE
  app = await electron.launch({
    args: [root],
    env: {
      ...env,
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: join(root, 'e2e/fixtures/pi-stub.cjs'),
      PHOSPHOR_E2E_WORKSPACE: workspace,
      PHOSPHOR_TEST_USER_DATA: profile,
      PI_CODING_AGENT_DIR: join(directory, 'agent'),
    },
  })
  page = await app.firstWindow()
  const routines = page.getByRole('button', { name: 'Routines', exact: true })
  const openFolder = page.getByRole('button', { name: 'Open Folder…', exact: true })
  await expect(routines.or(openFolder).first()).toBeVisible({ timeout: 30000 })
  if (await openFolder.isVisible()) await openFolder.click()
  await expect(routines).toBeVisible({ timeout: 30000 })
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'phosphor-routines-e2e-'))
  workspace = join(directory, 'workspace')
  profile = join(directory, 'profile')
  execFileSync('git', ['init', '-b', 'main', workspace])
  execFileSync('git', ['config', 'user.email', 'test@phosphor.invalid'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'Phosphor test'], { cwd: workspace })
  await writeFile(join(workspace, 'hello.ts'), 'export const hello = "new"\n')
  execFileSync('git', ['add', '.'], { cwd: workspace })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspace })
  await launch()
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true })
})

function definition(patch: Partial<RoutineInput> = {}): RoutineInput {
  return {
    ...newRoutine(workspace),
    name: 'Scheduled test',
    instructions: 'Create a report.',
    provider: 'stub',
    model: 'stub-model',
    timezone: 'UTC',
    trusted: true,
    enabled: false,
    ...patch,
  }
}
async function seed(input: RoutineInput): Promise<string> {
  return page.evaluate(async (r) => {
    await window.phosphor.invoke('routines:save', r)
    return (await window.phosphor.invoke('routines:list')).routines.at(-1)!.id
  }, input)
}

test('create, preview, run in an isolated lane, review history, and persist across restart', async () => {
  await page.getByRole('button', { name: 'Routines', exact: true }).click()
  await page.getByRole('button', { name: 'New routine', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'New routine' })
  await editor.getByLabel('Name', { exact: false }).fill('Weekly report')
  await editor.getByLabel('What should happen?').fill('Create a report of repository health.')
  await editor.getByLabel('Workspace', { exact: true }).fill(workspace)
  await editor
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption({ label: 'Stub Model · stub' })
  await editor.getByLabel('Task intent').selectOption('report')
  await editor.getByRole('button', { name: 'Weekly', exact: true }).click()
  await editor.getByLabel('Timezone', { exact: true }).fill('UTC')
  await expect(editor.getByText('Next runs', { exact: true })).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Enable routine' })).toBeDisabled()
  await editor.getByRole('checkbox').check()
  await page.screenshot({ path: test.info().outputPath('routine-editor.png') })
  await editor.getByRole('button', { name: 'Enable routine' }).click()
  await expect(editor).toHaveCount(0)
  await page.getByTestId('routine-row').filter({ hasText: 'Weekly report' }).click()
  const previousFolder = await page.evaluate(
    async () => (await window.phosphor.invoke('app:getPrefs')).lastWorkspacePath,
  )
  await page.getByRole('button', { name: 'Run now', exact: true }).click()
  await expect(
    page.getByTestId('routine-run').getByText('Finished · unverified', { exact: true }),
  ).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('session-row').first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('routine-history.png') })
  const snapshot = await page.evaluate(() => window.phosphor.invoke('routines:list'))
  const run = snapshot.runs[0]!
  expect(run.workspacePath).toContain('.phosphor/worktrees/')
  expect(run.branch).toMatch(/^phosphor\/routine\//)
  expect(run.baseCommit).toMatch(/^[a-f0-9]{40}$/)
  expect(run.sessionPath).toBeTruthy()
  expect(
    await page.evaluate(
      async () => (await window.phosphor.invoke('app:getPrefs')).lastWorkspacePath,
    ),
  ).toBe(previousFolder)
  expect(
    await page.evaluate(() => window.phosphor.invoke('pi:listLiveSessions')),
  ).not.toContainEqual(expect.objectContaining({ sessionId: run.sessionId }))
  await page.getByRole('button', { name: 'Open lane' }).click()
  await expect(page.getByTestId('global-page')).toHaveCount(0)
  await page.getByRole('button', { name: 'Routines', exact: true }).click()
  await page.getByTestId('routine-row').filter({ hasText: 'Weekly report' }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByText('Paused', { exact: true })).toBeVisible()
  await app.close()
  await launch()
  await page.getByRole('button', { name: 'Routines', exact: true }).click()
  await page.getByTestId('routine-row').filter({ hasText: 'Weekly report' }).click()
  await expect(page.getByText('Paused', { exact: true })).toBeVisible()
  await expect(
    page.getByTestId('routine-run').getByText('Finished · unverified', { exact: true }),
  ).toBeVisible()
})

test('a scheduled run executes with zero renderer windows and does not replay on reopen', async () => {
  test.setTimeout(90000)
  await page.evaluate(() => window.phosphor.invoke('routines:background', true))
  const id = await seed(
    definition({ enabled: true, schedule: { kind: 'once', at: Date.now() + 5000 } }),
  )
  await page.close()
  // Read the durable ledger from main, not a hidden renderer or test-only tick.
  await expect
    .poll(
      async () =>
        app.evaluate(async ({ app }, routineId) => {
          const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof Sqlite
          const { join } = process.getBuiltinModule('node:path') as typeof NodePath
          const db = new DatabaseSync(join(app.getPath('userData'), 'routines.sqlite'), {
            readOnly: true,
          })
          try {
            const rows = db.prepare('SELECT data FROM runs WHERE routine_id=?').all(routineId)
            return rows.map((r) => JSON.parse(r.data as string).status as string)
          } finally {
            db.close()
          }
        }, id),
      { timeout: 45000, intervals: [1000] },
    )
    .toEqual(['finished'])
  const opened = app.waitForEvent('window')
  await app.evaluate(({ app }) => app.emit('activate'))
  page = await opened
  await expect(page.getByRole('button', { name: 'Routines', exact: true })).toBeVisible()
  const state = await page.evaluate(() => window.phosphor.invoke('routines:list'))
  expect(state.runs.filter((r) => r.routineId === id)).toHaveLength(1)
  expect(state.routines.find((r) => r.id === id)?.nextAt).toBeNull()
})

test('deduplicates Run now and cancels a running routine without leaving a worker', async () => {
  const id = await seed(definition({ instructions: 'routine-e2e-hold' }))
  const runs = await page.evaluate(
    async (routineId) =>
      Promise.all([
        window.phosphor.invoke('routines:run', routineId, 'click-one'),
        window.phosphor.invoke('routines:run', routineId, 'click-two'),
      ]),
    id,
  )
  expect(runs[0]!.id).toBe(runs[1]!.id)
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.phosphor.invoke('routines:list'))).runs[0]?.sessionId,
    )
    .toBeTruthy()
  await page.evaluate((runId) => window.phosphor.invoke('routines:cancel', runId), runs[0]!.id)
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.phosphor.invoke('routines:list'))).runs[0]?.status,
    )
    .toBe('cancelled')
  const state = await page.evaluate(() => window.phosphor.invoke('routines:list'))
  const live = await page.evaluate(() => window.phosphor.invoke('pi:listLiveSessions'))
  expect(live.some((s) => s.sessionId === state.runs[0]?.sessionId)).toBe(false)
})

test('failed isolation blocks instead of silently running in the main checkout', async () => {
  const id = await seed(definition({ workspacePath: directory }))
  await page.evaluate(
    (routineId) => window.phosphor.invoke('routines:run', routineId, 'isolation'),
    id,
  )
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.phosphor.invoke('routines:list'))).runs[0]?.status,
    )
    .toBe('blocked')
  const state = await page.evaluate(() => window.phosphor.invoke('routines:list'))
  expect(state.runs[0]?.sessionId).toBeNull()
  expect(state.routines[0]?.enabled).toBe(false)
  expect(state.routines[0]?.attention).toContain('Isolation required')
})
