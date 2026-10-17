import { desktopElectronLaunchOptions } from '../../../tools/scripts/desktop-electron-launch.mjs'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { symlinkSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { newRoutine } from '../../../libs/shared/src/routines'
import { configureTestTeardown } from './fixtures/shutdown'
import { scratchDir } from './fixtures/scratch'

/**
 * Main refuses the tree view's history edits while a lane in this process owns
 * the transcript, whatever the renderer did first. The edits are sent straight
 * over IPC, as a renderer that skipped closing its lane would send them.
 */

const root = resolve(import.meta.dirname, '..')
let app: ElectronApplication
let page: Page
let directory: string
let workspace: string

async function launch(): Promise<void> {
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_CLI_ARGS
  delete env.NODE_ENV_ELECTRON_VITE
  app = await electron.launch({
    ...desktopElectronLaunchOptions([root]),
    env: {
      ...env,
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: join(root, 'e2e/fixtures/pi-stub.cjs'),
      PHOSPHOR_E2E_WORKSPACE: workspace,
      PHOSPHOR_TEST_USER_DATA: join(directory, 'profile'),
      PI_CODING_AGENT_DIR: join(directory, 'agent'),
    },
  })
  configureTestTeardown(app)
  page = await app.firstWindow()
  const routines = page.getByRole('button', { name: 'Routines', exact: true })
  const openFolder = page.getByRole('button', { name: 'Open Folder…', exact: true })
  await expect(routines.or(openFolder).first()).toBeVisible({ timeout: 30000 })
}

test.beforeEach(async () => {
  directory = await scratchDir('phosphor-writer-lock-e2e-')
  workspace = join(directory, 'workspace')
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
  await rm(`${directory}-alias`, { force: true })
  await rm(directory, { recursive: true, force: true })
})

/** The IPC outcome as text: 'ok', or the error the renderer would see. */
function edit(kind: 'label' | 'jump', file: string): Promise<string> {
  return page.evaluate(
    async ([kind, file]) => {
      try {
        if (kind === 'label')
          await window.phosphor.invoke('sessions:appendLabel', file, 'aaaa0001', 'e2e mark')
        else await window.phosphor.invoke('sessions:jump', file, 'aaaa0001')
        return 'ok'
      } catch (error) {
        return String(error)
      }
    },
    [kind, file] as const,
  )
}
const forkAt = (file: string): Promise<string> =>
  page.evaluate((file) => window.phosphor.invoke('sessions:forkAt', file, 'aaaa0001'), file)
/** The transcript pi reports for a live lane. */
const sessionFileOf = (id: string): Promise<string | undefined> =>
  page.evaluate(async (id) => {
    const state = await window.phosphor.piCommand(id, { type: 'get_state' })
    return state.success ? state.data?.sessionFile : undefined
  }, id)
const header = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse((await readFile(file, 'utf8')).split('\n')[0]!) as Record<string, unknown>

test('a live lane refuses label and jump, a fork leaves it intact, and closed edits resume', async () => {
  const live = await page.evaluate(
    (workspacePath) => window.phosphor.invoke('pi:createSession', { workspacePath }),
    workspace,
  )
  const file = await sessionFileOf(live.sessionId)
  if (!file) throw new Error('the stub reported no session file')
  // A second spelling of the same transcript, through a symlinked folder.
  symlinkSync(directory, `${directory}-alias`)
  const alias = join(`${directory}-alias`, file.slice(directory.length + 1))
  const before = await readFile(file, 'utf8')

  expect(await edit('label', file)).toContain('still open')
  expect(await edit('jump', alias)).toContain('still open')
  expect(await readFile(file, 'utf8')).toBe(before)
  // The deliberate exception: a fork only reads its source.
  const liveFork = await forkAt(file)
  expect(dirname(liveFork)).toBe(dirname(file))
  expect(await header(liveFork)).toMatchObject({ type: 'session', parentSession: file })
  expect(await readFile(file, 'utf8')).toBe(before)

  await page.evaluate((id) => window.phosphor.invoke('pi:disposeSession', id), live.sessionId)
  expect(await edit('label', file)).toBe('ok')
  expect(await edit('jump', alias)).toBe('ok')
  const closedFork = await forkAt(file)
  const tree = await page.evaluate((f) => window.phosphor.invoke('sessions:readTree', f), file)
  expect(tree.entries.map((e) => e.type)).toEqual(
    expect.arrayContaining(['label', 'branch_summary']),
  )
  const raw = await readFile(file, 'utf8')
  expect(raw.startsWith(before)).toBe(true)
  for (const line of raw.trimEnd().split('\n')) expect(() => JSON.parse(line)).not.toThrow()

  // Both edited transcripts resume, and the resumed lane owns its file again.
  for (const sessionPath of [file, closedFork]) {
    const resumed = await page.evaluate(
      ([workspacePath, sessionPath]) =>
        window.phosphor.invoke('pi:createSession', { workspacePath, sessionPath }),
      [workspace, sessionPath] as const,
    )
    expect(await sessionFileOf(resumed.sessionId)).toBe(sessionPath)
  }
  expect(await edit('label', file)).toContain('still open')
  expect(basename(closedFork)).not.toBe(basename(file))
})

test('a running routine’s transcript refuses label and jump until the routine stops', async () => {
  test.setTimeout(90000)
  const routineId = await page.evaluate(
    async (input) => {
      await window.phosphor.invoke('routines:save', input)
      return (await window.phosphor.invoke('routines:list')).routines.at(-1)!.id
    },
    {
      ...newRoutine(workspace),
      name: 'Held routine',
      instructions: 'routine-e2e-hold',
      provider: 'stub',
      model: 'stub-model',
      timezone: 'UTC',
      trusted: true,
      enabled: false,
    },
  )
  const run = await page.evaluate(
    (id) => window.phosphor.invoke('routines:run', id, 'writer-lock'),
    routineId,
  )
  const sessionPath = async (): Promise<string | undefined> =>
    (await page.evaluate(() => window.phosphor.invoke('routines:list'))).runs[0]?.sessionPath ??
    undefined
  await expect.poll(sessionPath).toBeTruthy()
  const file = (await sessionPath())!
  const before = await readFile(file, 'utf8')

  expect(await edit('label', file)).toContain('running routine')
  expect(await edit('jump', file)).toContain('running routine')
  expect(await readFile(file, 'utf8')).toBe(before)

  await page.evaluate((id) => window.phosphor.invoke('routines:cancel', id), run.id)
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.phosphor.invoke('routines:list'))).runs[0]?.status,
    )
    .toBe('cancelled')
  // Once the routine has released its lane, the same edit goes through.
  await expect.poll(() => edit('label', file), { timeout: 15000 }).toBe('ok')
  expect((await readFile(file, 'utf8')).startsWith(before)).toBe(true)
})
