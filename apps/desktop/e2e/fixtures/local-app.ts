import { desktopElectronLaunchOptions } from '../../../../tools/scripts/desktop-electron-launch.mjs'
import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scratchDir, scratchDirSync } from './scratch'
import { configureTestTeardown } from './shutdown'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const piStub = join(repoRoot, 'e2e', 'fixtures', 'pi-stub.cjs')

export interface Harness {
  app: ElectronApplication
  page: Page
  workspace: string
}

/**
 * Launch Phosphor against a deterministic pi stub in a scratch workspace.
 * Each test gets its own instance so no test can leave focus or pane state
 * that breaks the next one.
 */
/**
 * Scratch pi-agent dir for the whole e2e run, so stub sessions are never
 * written into the developer's real ~/.pi.
 */
export const agentDir = scratchDirSync('phosphor-e2e-agent-')

/**
 * A pi-agent dir of one test's own, for tests that seed `npm/node_modules`
 * with a fixture package.
 *
 * The shared `agentDir` above cannot be used for those. Several surfaces run a
 * REAL `npm install` into `<agentDir>/npm` — Settings installs packages,
 * and pi installs whatever `settings.json` declares — and npm owns
 * `node_modules` wholesale: it prunes anything absent from its own manifest,
 * which is exactly what a hand-written fixture directory is. The result was a
 * test that passed alone and failed in the suite, because the pruning install
 * only wins the race once npm's cache is warm from an earlier test.
 *
 * Isolating the dir is the fix rather than ordering the tests: it makes the
 * fixture unreachable by any other test's installer, in either direction.
 */
export function privateAgentDir(): string {
  return scratchDirSync('phosphor-e2e-agent-solo-')
}

/**
 * `process.env` minus electron-vite's dev markers.
 *
 * main.ts decides dev-vs-built purely from `ELECTRON_RENDERER_URL`, and that
 * variable is exported into every child of `npm run dev`. Running the e2e
 * suite from a shell descended from a dev server therefore launched the built
 * main against the DEV SERVER's renderer: the suite silently tested code that
 * was never built, so it passed for the wrong reasons and failed on changes it
 * had never loaded. Strip the markers so a launch here always means `out/`.
 */
function devServerEnvStripped(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.ELECTRON_CLI_ARGS
  return env
}

export async function launch(
  options: {
    workspace?: string
    userDataDir?: string
    /** Override the run-wide agent dir; see `privateAgentDir`. */
    agentDir?: string
    env?: Record<string, string>
  } = {},
): Promise<Harness> {
  const workspace = options.workspace ?? (await scratchDir('phosphor-e2e-'))
  await writeFile(join(workspace, 'hello.ts'), 'export function hello() {\n  return "new"\n}\n')

  const app = await electron.launch({
    ...desktopElectronLaunchOptions([repoRoot]),
    env: {
      ...devServerEnvStripped(),
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: piStub,
      PHOSPHOR_E2E_WORKSPACE: workspace,
      PHOSPHOR_TEST_USER_DATA: options.userDataDir ?? '1',
      PI_CODING_AGENT_DIR: options.agentDir ?? agentDir,
      ...options.env,
    },
  })
  configureTestTeardown(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, workspace }
}

/**
 * Close the app and remove everything it created: the scratch workspace and
 * the isolated userData dir main.ts points at for E2E runs (named by pid).
 */
export async function shutdown(harness: Harness): Promise<void> {
  const pid = harness.app.process().pid
  await harness.app.close()
  await rm(harness.workspace, { recursive: true, force: true })
  if (pid !== undefined) {
    await rm(join(tmpdir(), `phosphor-e2e-${pid}`), { recursive: true, force: true })
  }
}

/**
 * Get to the workspace home.
 *
 * The app restores its last location on launch, so a run may land on the
 * picker OR straight into a restored session. Wait for whichever appears
 * rather than assuming the picker — assuming it made this flaky, with the
 * 30s wait burned before failing.
 */
export async function openWorkspace(page: Page): Promise<void> {
  const picker = page.getByRole('button', { name: /Open Folder/i })
  const homeComposer = page.getByPlaceholder('Describe a task or ask a question')
  const chatComposer = page.getByPlaceholder(/Describe a task…/i)

  await expect(picker.or(homeComposer).or(chatComposer).first()).toBeVisible({ timeout: 30_000 })

  if (await picker.isVisible()) {
    await picker.click()
  } else if (await chatComposer.isVisible()) {
    // Restored into a session — get back to the home screen.
    await page.getByRole('button', { name: /^New$/ }).click()
  }
  await expect(homeComposer).toBeVisible({ timeout: 20_000 })
}
