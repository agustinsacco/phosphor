import { desktopElectronLaunchOptions } from '../../../tools/scripts/desktop-electron-launch.mjs'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scratchDir } from './fixtures/scratch'
import { configureTestTeardown } from './fixtures/shutdown'

let app: ElectronApplication
let page: Page
let scratch: string
let repo: string
let lane: string
let transcript: string
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function launch(): Promise<void> {
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_CLI_ARGS
  delete env.NODE_ENV_ELECTRON_VITE
  app = await electron.launch({
    ...desktopElectronLaunchOptions([resolve(import.meta.dirname, '..')]),
    env: {
      ...env,
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: resolve(import.meta.dirname, 'fixtures/pi-stub.cjs'),
      PHOSPHOR_TEST_USER_DATA: join(scratch, 'profile'),
      PI_CODING_AGENT_DIR: join(scratch, 'agent'),
    },
  })
  configureTestTeardown(app)
  page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(
    page.getByTestId('session-row').filter({ hasText: 'Unfinished research audit' }),
  ).toBeVisible()
}

test.beforeEach(async () => {
  scratch = await realpath(await scratchDir('phosphor-cleanup-e2e-'))
  repo = join(scratch, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'readme'), 'research checkout\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  lane = join(repo, '.phosphor', 'worktrees', 'research')
  git(repo, 'worktree', 'add', '-b', 'research', lane, 'main')
  const dir = join(
    scratch,
    'agent',
    'sessions',
    `--${lane.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`,
  )
  await mkdir(dir, { recursive: true })
  transcript = join(dir, 'research.jsonl')
  await writeFile(
    transcript,
    [
      {
        type: 'session',
        version: 3,
        id: 'research-conversation',
        cwd: lane,
        timestamp: '2026-09-01T00:00:00Z',
      },
      {
        type: 'session_info',
        id: 'name0001',
        parentId: null,
        name: 'Unfinished research audit',
        timestamp: '2026-09-01T00:00:01Z',
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  )
  await mkdir(join(scratch, 'profile'))
  await writeFile(
    join(scratch, 'profile', 'config.json'),
    JSON.stringify({
      lastWorkspacePath: repo,
      recentWorkspaces: [{ path: repo, name: 'repo' }],
      maintenance: {
        enabled: false,
        reclaimMergedWorktrees: true,
        minAgeHours: 1,
        intervalMinutes: 60,
      },
    }),
  )
  await launch()
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  await rm(scratch, { recursive: true, force: true })
})

test('unfinished sessions survive restart; explicit completion retains sidebar history and exact-tip restore', async () => {
  test.setTimeout(120_000)
  const original = await readFile(transcript, 'utf8')
  const tip = git(lane, 'rev-parse', 'HEAD')
  for (let restart = 0; restart < 2; restart++) {
    const report = await page.evaluate(() => window.phosphor.invoke('maintenance:run'))
    expect(report.flatMap((entry) => entry.reclaimed)).toEqual([])
    expect(report.flatMap((entry) => entry.held)).toContainEqual(
      expect.objectContaining({ path: lane, reason: 'unfinished' }),
    )
    expect(existsSync(lane)).toBe(true)
    if (restart === 0) {
      await app.close()
      await launch()
    }
  }
  let row = page.getByTestId('session-row').filter({ hasText: 'Unfinished research audit' })
  await row.click({ button: 'right' })
  await page.getByText('Finish conversation…', { exact: true }).click()
  await page.getByRole('button', { name: 'Finish conversation', exact: true }).click()
  await expect(row.locator('[data-segment="state"]')).toContainText('finished')
  await app.close()

  // Advance the fixture past the grace period without changing production clocks.
  const old = new Date(Date.now() - 72 * 3_600_000)
  const historyPath = join(scratch, 'profile', 'session-maintenance.json')
  const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
    sessions: Record<string, { completedAt: number; activityAt: number }>
  }
  history.sessions[transcript] = { completedAt: old.getTime(), activityAt: old.getTime() }
  await writeFile(historyPath, JSON.stringify(history))
  for (const path of [transcript, join(transcript, '..'), lane]) await utimes(path, old, old)
  await launch()
  const report = await page.evaluate(() => window.phosphor.invoke('maintenance:run'))
  expect(report.flatMap((entry) => entry.errors)).toEqual([])
  expect(report.flatMap((entry) => entry.reclaimed).map((entry) => entry.path)).toEqual([lane])
  expect(existsSync(lane)).toBe(false)
  row = page.getByTestId('session-row').filter({ hasText: 'Unfinished research audit' })
  await expect(row).toContainText('worktree removed')
  await page.reload()
  row = page.getByTestId('session-row').filter({ hasText: 'Unfinished research audit' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('worktree removed')
  await row.click({ button: 'right' })
  await page.getByText('Restore worktree', { exact: true }).click()
  await expect(row).not.toContainText('worktree removed')
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(tip)
  expect(await readFile(transcript, 'utf8')).toBe(original)
  const sessions = await page.evaluate((cwd) => window.phosphor.invoke('sessions:list', cwd), lane)
  expect(sessions[0]?.sessionId).toBe('research-conversation')
  // Admission resumes the same conversation and resets its completion decision.
  const live = await page.evaluate(
    ([workspacePath, sessionPath]) =>
      window.phosphor.invoke('pi:createSession', { workspacePath, sessionPath }),
    [lane, transcript] as const,
  )
  expect(
    (await page.evaluate((cwd) => window.phosphor.invoke('sessions:list', cwd), lane))[0]
      ?.completedAt,
  ).toBeUndefined()
  await page.evaluate((id) => window.phosphor.invoke('pi:disposeSession', id), live.sessionId)
})
