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
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scratchDir } from './fixtures/scratch'
import { configureTestTeardown } from './fixtures/shutdown'

const TITLE = 'Archived research audit'
let app: ElectronApplication
let page: Page
let scratch: string
let lane: string
let transcript: string
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test.beforeEach(async () => {
  scratch = await realpath(await scratchDir('phosphor-archive-e2e-'))
  const repo = join(scratch, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'readme'), 'research checkout\n')
  await writeFile(join(repo, '.gitignore'), '.env\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  lane = join(repo, '.phosphor', 'worktrees', 'research')
  git(repo, 'worktree', 'add', '-b', 'research', lane, 'main')
  await writeFile(join(lane, 'notes.txt'), 'untracked work\n')
  await writeFile(join(lane, '.env'), 'ignored secret\n')
  const dir = join(
    scratch,
    'agent',
    'sessions',
    `--${lane.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`,
  )
  await mkdir(dir, { recursive: true })
  transcript = join(dir, 'research.jsonl')
  const entries = [
    { type: 'session', version: 3, id: 'research', cwd: lane, timestamp: '2026-09-01T00:00:00Z' },
    {
      type: 'session_info',
      id: 'n1',
      parentId: null,
      name: TITLE,
      timestamp: '2026-09-01T00:00:01Z',
    },
  ]
  await writeFile(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  await mkdir(join(scratch, 'profile'))
  await writeFile(
    join(scratch, 'profile', 'config.json'),
    JSON.stringify({ lastWorkspacePath: repo, recentWorkspaces: [{ path: repo, name: 'repo' }] }),
  )
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
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  await rm(scratch, { recursive: true, force: true })
})

test('archiving a lane keeps its whole checkout, and the Archive page restores it', async () => {
  const row = page.getByTestId('session-row').filter({ hasText: TITLE })
  await row.click({ button: 'right' })
  await page
    .getByTestId('context-menu')
    .getByRole('button', { name: /^Archive/ })
    .click()
  await page.getByRole('button', { name: 'Archive lane', exact: true }).click()
  await expect(row).toHaveCount(0)
  expect(existsSync(transcript)).toBe(false)
  expect(existsSync(`${transcript}.archived`)).toBe(true)
  expect(await readFile(join(lane, 'notes.txt'), 'utf8')).toBe('untracked work\n')
  expect(await readFile(join(lane, '.env'), 'utf8')).toBe('ignored secret\n')
  expect(git(lane, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('research')

  await page.getByRole('button', { name: 'Archive', exact: true }).first().click()
  const entry = page.getByTestId('archive-row').filter({ hasText: TITLE })
  // The row names the checkout it left behind. A plain archive carries no state
  // chip; only archiving/restoring/purging do, so the eye catches in-flight work.
  await expect(entry).toContainText(lane)
  await entry.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('No archived lanes.')).toBeVisible()
  expect(existsSync(transcript)).toBe(true)
  expect(existsSync(`${transcript}.archived`)).toBe(false)
  await expect(page.getByTestId('session-row').filter({ hasText: TITLE })).toBeVisible()
})
