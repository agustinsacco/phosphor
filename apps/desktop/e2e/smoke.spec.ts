import { desktopElectronLaunchOptions } from '../../../tools/scripts/desktop-electron-launch.mjs'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { scratchDir, scratchDirSync } from './fixtures/scratch'
import { configureTestTeardown } from './fixtures/shutdown'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const piStub = join(repoRoot, 'e2e', 'fixtures', 'pi-stub.cjs')

interface Harness {
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
const agentDir = scratchDirSync('phosphor-e2e-agent-')

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
function privateAgentDir(): string {
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

async function launch(
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
async function shutdown(harness: Harness): Promise<void> {
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
async function openWorkspace(page: Page): Promise<void> {
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

/** scrollTop is fractional; scrollHeight/clientHeight are rounded. Capture the
 * observed position BEFORE measuring the native limit, then restore it. This
 * retains an exact end-position assertion without a font-dependent 1px oracle.
 */
function scrollPosition(el: HTMLElement): { top: number; max: number } {
  const top = el.scrollTop
  el.scrollTop = el.scrollHeight
  const max = el.scrollTop
  el.scrollTop = top
  return { top, max }
}

test('action hints stay quiet and dismiss before menus or dialogs', async () => {
  const h = await launch()
  const { page } = h
  try {
    await openWorkspace(page)
    const attach = page.getByRole('button', { name: 'Attach files', exact: true })
    const tooltip = page.getByRole('tooltip')
    await attach.hover()
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveText('Attach files')
    await expect(attach).not.toHaveAttribute('title')
    // Click-through: a hint over a neighbouring control never intercepts it.
    await expect(tooltip).toHaveCSS('pointer-events', 'none')
    const bounds = await tooltip.boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(bounds!.x).toBeGreaterThanOrEqual(8)
    expect(bounds!.y).toBeGreaterThanOrEqual(8)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 8)

    // A disabled action still explains itself on hover.
    const start = page.getByRole('button', { name: 'Start session', exact: true })
    await expect(start).toBeDisabled()
    await start.hover()
    await expect(tooltip).toContainText('Start session')
    await page.mouse.move(0, 0)
    await expect(tooltip).toHaveCount(0)

    // Clicks must never leave the old hint over a newly opened surface.
    await page.getByRole('button', { name: /^Settings/ }).click()
    await expect(tooltip).toHaveCount(0)
    const close = page.getByRole('button', { name: 'Close settings', exact: true })
    await close.hover()
    await expect(tooltip).toHaveText('Close settings')
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect(close).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(close).toHaveCount(0)

    // Text actions, disabled controls, and icon actions all opt into the host.
    const missing = await page
      .locator('button')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => !node.getAttribute('data-tooltip'))
          .map((node) => node.outerHTML.slice(0, 180)),
      )
    expect(missing).toEqual([])
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await attach.hover()
    await expect(tooltip).toBeVisible()
    expect(await tooltip.evaluate((node) => getComputedStyle(node).animationName)).toBe('none')
    await page.screenshot({ path: test.info().outputPath('quiet-tooltips.png') })
  } finally {
    await shutdown(h)
  }
})

test('new lane shares Swarm and file mentions, applying authorization before the first prompt', async () => {
  const workspace = await scratchDir('phosphor-e2e-swarm-')
  const log = join(workspace, 'commands.jsonl')
  const h = await launch({ workspace, env: { PHOSPHOR_E2E_COMMAND_LOG: log } })
  const { page } = h
  const prompts = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((c) => c.type === 'prompt')
      .map((c) => c.message)
  try {
    await openWorkspace(page)
    const toggle = page.getByRole('switch', { name: 'Swarm', exact: true })
    await expect(toggle).not.toBeChecked()
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toBeChecked()
    expect(await prompts()).toEqual([])
    // The choice survives a renderer reload even before any text is entered.
    await expect
      .poll(() =>
        page.evaluate(async () =>
          Object.values((await window.phosphor.invoke('app:getPrefs')).drafts).some(
            (draft) => draft.swarm,
          ),
        ),
      )
      .toBe(true)
    await page.reload()
    const home = page.getByPlaceholder('Describe a task or ask a question')
    await expect(home).toBeVisible()
    await expect(toggle).toBeChecked()
    await home.fill('Review @hello')
    await expect(page.getByRole('button', { name: 'hello.ts', exact: true })).toBeVisible()
    await home.press('Enter') // selects the mention; does not send
    await expect(home).toHaveValue('Review hello.ts ')
    expect(await prompts()).toEqual([])
    await home.press('Enter')
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    await expect(toggle).toBeChecked()
    await expect.poll(prompts).toEqual(['/phosphor-swarm on', 'Review hello.ts'])
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 20_000,
    })
    const live = page.getByPlaceholder(/Describe a task…/i)
    await live.fill('Check @hello')
    await expect(page.getByRole('button', { name: 'hello.ts', exact: true })).toBeVisible()
    await live.press('Tab')
    await expect(live).toHaveValue('Check hello.ts ')
    await page.getByRole('button', { name: /^New$/ }).click()
    await expect(home).toBeVisible()
    await expect(toggle).not.toBeChecked() // not a global preference
    await page.screenshot({ path: test.info().outputPath('new-lane-shared-composer.png') })
  } finally {
    await shutdown(h)
  }
})

test('new lane restores its draft and Swarm choice if pi-subagents is unavailable', async () => {
  const h = await launch({ env: { PHOSPHOR_E2E_SWARM_UNAVAILABLE: '1' } })
  const { page } = h
  try {
    await openWorkspace(page)
    const home = page.getByPlaceholder('Describe a task or ask a question')
    const toggle = page.getByRole('switch', { name: 'Swarm', exact: true })
    await toggle.click()
    await home.fill('Keep this task')
    await home.press('Enter')
    await expect(
      page.getByText(/Couldn't start this session.*Swarm requires pi-subagents/),
    ).toBeVisible()
    await expect(home).toHaveValue('Keep this task')
    await expect(toggle).toBeChecked()
    await expect(page.getByTestId('user-message')).toHaveCount(0)
    await toggle.click()
    await home.press('Enter')
    await expect(page.getByTestId('user-message')).toHaveCount(1)
  } finally {
    await shutdown(h)
  }
})

test('new lane accepts an image-only first prompt', async () => {
  const h = await launch()
  const { page } = h
  try {
    await openWorkspace(page)
    await page.evaluate((png) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(
        new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'dot.png', {
          type: 'image/png',
        }),
      )
      document
        .querySelector('[data-swarm-enabled]')!
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    }, PNG_1X1)
    await expect(page.getByRole('button', { name: 'Attached image', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Start session', exact: true }).click()
    // Image-only messages have no text bubble (the user-message test id).
    await expect(page.getByPlaceholder(/Describe a task…/i)).toBeVisible()
    await expect(page.getByRole('img', { name: 'Attached image', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 20_000,
    })
  } finally {
    await shutdown(h)
  }
})

test('Swarm toggles lane authorization without sending a turn and honors reduced motion', async () => {
  const h = await launch()
  const { page } = h
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    const toggle = page.getByRole('switch', { name: 'Swarm', exact: true })
    await expect(toggle).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 20_000,
    })
    const messages = await page.getByTestId('user-message').count()
    const draft = page.getByPlaceholder(/Describe a task…/i)
    await draft.fill('Keep this draft')
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeFocused()
    await expect(page.locator('[data-swarm-enabled="true"]')).toBeVisible()
    await expect(
      page.locator('[data-tooltip="Swarm authorization enabled for this lane"]'),
    ).toBeVisible()
    await expect(page.getByTestId('user-message')).toHaveCount(messages)
    await expect(draft).toHaveValue('Keep this draft')
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
    await expect(page.getByText(/"version":1,"available":true/)).toHaveCount(0)
    // The fan-out is tied to the off→on transition pi reported, not to hover;
    // reduced motion drops it while the geometry still carries the state.
    await expect(toggle).toHaveAttribute('data-state', 'on')
    await expect(toggle).toHaveAttribute('data-activated', 'true')
    const headAnimation = (): Promise<string> =>
      toggle
        .locator('.swarm-head')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName)
    expect(await headAnimation()).toBe('swarm-fan-out')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await headAnimation()).toBe('none')
    await page.emulateMedia({ reducedMotion: null })
    await page.screenshot({ path: test.info().outputPath('swarm-enabled.png') })
    async function stubCommand(message: string): Promise<void> {
      const result = await page.evaluate(async (text) => {
        const live = await window.phosphor.invoke('pi:listLiveSessions')
        if (live.length !== 1) throw new Error('Expected one isolated stub session')
        return window.phosphor.piCommand(live[0]!.sessionId, { type: 'prompt', message: text })
      }, message)
      expect(result.success).toBe(true)
    }
    async function screenshot(name: string): Promise<void> {
      // CDP screenshots crop the native viewport at Electron zoom.
      const png = await h.app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage())
          .toPNG()
          .toString('base64'),
      )
      await writeFile(test.info().outputPath(name), Buffer.from(png, 'base64'))
    }
    async function expectFooterFits(): Promise<void> {
      const card = (await page.locator('[data-swarm-enabled]').boundingBox())!
      const boxes = []
      for (const control of [
        toggle,
        page.getByTestId('model-chip'),
        page.getByRole('button', { name: 'Attach files', exact: true }),
        page.getByTestId('context-meter'),
        page.getByRole('button', { name: 'Send message', exact: true }),
      ]) {
        const box = (await control.boundingBox())!
        expect(box.width).toBeGreaterThanOrEqual(24)
        expect(box.x).toBeGreaterThanOrEqual(card.x)
        expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width)
        for (const other of boxes) {
          const overlapX =
            Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x)
          const overlapY =
            Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y)
          expect(overlapX <= 1 || overlapY <= 1, 'Composer controls must not overlap').toBe(true)
        }
        boxes.push(box)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
    await stubCommand('/stub-swarm-post-run')
    await expect(page.getByText('compacting…', { exact: true })).toBeVisible()
    await h.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.setContentSize(1000, 740)
      win.webContents.setZoomFactor(1.25)
    })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.classList.toggle('dark', value === 'dark')
      }, theme)
      await expect(page.locator('[data-swarm-enabled]')).toHaveCSS(
        'background-color',
        theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 39, 33)',
      )
      // Measure the actual rendered label/badge colors, not duplicated theme tokens.
      for (const control of [
        toggle,
        page.locator('[data-tooltip="Swarm authorization enabled for this lane"]'),
      ]) {
        const contrast = await control.evaluate((el) => {
          const css = getComputedStyle(el)
          const luminance = (color: string) => {
            const channels = color
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number)
              .map((n) => {
                const s = n / 255
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
              })
            const [red, green, blue] = channels
            if (red === undefined || green === undefined || blue === undefined)
              throw new Error(`Expected an rgb colour, got ${color}`)
            return red * 0.2126 + green * 0.7152 + blue * 0.0722
          }
          const a = luminance(css.color),
            b = luminance(css.backgroundColor)
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        })
        expect(contrast).toBeGreaterThanOrEqual(4.5)
      }
      await screenshot(`swarm-${theme}-narrow-enabled.png`)
      await toggle.focus()
      await page.keyboard.press('Space')
      // Pending is loud now: dashed pill and outline, a tag, and a toast that
      // says what the click did. It used to be an 11px suffix beside an
      // unmoved knob, which read as a click that did not take.
      await expect(toggle).toHaveAttribute('data-state', 'pending')
      await expect(toggle).toContainText(/off next turn/i)
      await expect(toggle).toBeChecked() // native acknowledgement still says on
      await expect(toggle).toBeFocused()
      await expect(toggle).toHaveAttribute('aria-busy', 'true')
      await expect(page.getByText('Swarm turns off after this turn.').last()).toBeVisible()
      await expect(page.locator('[data-swarm-enabled]')).toHaveClass(/border-dashed/)
      await expectFooterFits()
      await screenshot(`swarm-${theme}-narrow-pending.png`)
      if (theme === 'light') {
        await page.keyboard.press('Space') // cancel the pending disable
        await expect(toggle).toHaveAttribute('data-state', 'on')
        await expect(page.getByText('Swarm request cancelled.').last()).toBeVisible()
        await expect(page.locator('[data-swarm-enabled]')).not.toHaveClass(/border-dashed/)
      }
    }
    await stubCommand('/stub-settle-swarm')
    await expect(toggle).not.toBeChecked() // no second agent_end was emitted
    await expect(toggle).toHaveAttribute('aria-busy', 'false')
    await expect(toggle).toHaveAttribute('data-state', 'off')
    await expect(toggle).toBeFocused()
    await expect(page.locator('[data-swarm-enabled="false"]')).toBeVisible()
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
        theme,
      )
      await expect(page.locator('[data-swarm-enabled]')).toHaveCSS(
        'background-color',
        theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 39, 33)',
      )
      await expectFooterFits()
      await screenshot(`swarm-${theme}-narrow-off.png`)
    }
    await expect(
      page.locator('[data-tooltip="Swarm authorization enabled for this lane"]'),
    ).toHaveCount(0)
    await expect(page.getByTestId('user-message')).toHaveCount(messages)
    await expect(draft).toHaveValue('Keep this draft')
    // Authorization is per lane: a new lane starts off even after this one was on.
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toBeChecked()
    await page.getByRole('button', { name: /^New$/ }).click()
    await page.getByPlaceholder('Describe a task or ask a question').fill('second lane')
    await page.getByRole('button', { name: /Start session/i }).click()
    const fresh = page.getByRole('switch', { name: 'Swarm', exact: true })
    await expect(fresh).toHaveAttribute('data-state', 'off', { timeout: 20_000 })
    await expect(fresh).not.toBeChecked()
  } finally {
    await shutdown(h)
  }
})

test('instruction sources distinguish global and project files in the composer', async () => {
  const h = await launch()
  const { page } = h
  try {
    await openWorkspace(page)
    await page.getByTestId('context-sources').click()
    await expect(
      page.getByText('Paths and scopes appear after a lane starts.').first(),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByPlaceholder('Describe a task or ask a question').fill('contextsources')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByPlaceholder(/Describe a task…/i)).toBeVisible()
    await page.getByTestId('context-sources').click()
    const sources = page.getByRole('list', { name: 'AGENTS.md sources' })
    const global = sources.getByRole('listitem').filter({ hasText: 'Global' })
    const project = sources.getByRole('listitem').filter({ hasText: 'Project' })
    await expect(global).toContainText(join(agentDir, 'AGENTS.md'))
    await expect(project).toContainText(join(h.workspace, 'AGENTS.md'))
    await expect(global).toContainText('Included · ~200')
    await expect(project).toContainText('Included · ~800')
    await expect(page.getByRole('checkbox', { name: 'AGENTS.md', exact: true })).toBeChecked()
    await page.screenshot({ path: test.info().outputPath('instruction-sources.png') })
  } finally {
    await shutdown(h)
  }
})

test('Mermaid viewer fits, zooms, pans, exports and restores focus @system-clipboard', async () => {
  const h = await launch()
  const { page } = h
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('mermaidviewer')
    await page.getByRole('button', { name: /Start session/i }).click()
    const expand = page.getByRole('button', { name: 'Expand Mermaid diagram' })
    await expand.focus()
    await expand.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Mermaid diagram' })
    const canvas = dialog.getByLabel('Diagram canvas')
    const image = canvas.locator('svg').first()
    const level = dialog.getByLabel('Zoom level')
    await expect(canvas).toBeFocused()
    await expect
      .poll(async () => {
        const width = (await image.boundingBox())?.width
        const viewport = await canvas.boundingBox()
        return width && viewport ? Math.abs(width - (viewport.width - 64)) : Infinity
      })
      .toBeLessThan(1)
    const fitWidth = (await image.boundingBox())!.width
    expect(fitWidth).toBeGreaterThan((await canvas.boundingBox())!.width * 0.85)
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fitWidth)
    await dialog.getByRole('button', { name: '100%', exact: true }).click()
    await expect(level).toHaveText('100%')
    await canvas.focus()
    await canvas.press('-')
    await expect(level).toHaveText('80%')
    const before = (await image.boundingBox())!
    const bounds = (await canvas.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40)
    await page.mouse.up()
    await expect.poll(async () => Math.round((await image.boundingBox())!.x - before.x)).toBe(80)
    await page.mouse.wheel(0, -200)
    await expect(level).not.toHaveText('80%')
    await canvas.press('f')
    await expect
      .poll(async () => Math.round((await image.boundingBox())!.width))
      .toBe(Math.round(fitWidth))
    await dialog.getByRole('button', { name: 'Copy source' }).click()
    await expect
      .poll(() => h.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('flowchart LR')
    const output = join(h.workspace, 'diagram.svg')
    await h.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, output)
    await dialog.getByRole('button', { name: 'Save SVG' }).click()
    await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toContain('<svg')
    expect(await readFile(output, 'utf8')).toContain('Stage 11')
    await page.screenshot({ path: test.info().outputPath('mermaid-viewer.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(expand).toBeFocused()
    await expand.press('Space')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close diagram' }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Light', exact: true }).click()
    await page.keyboard.press('Escape')
    await expand.click()
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 700))
    await expect
      .poll(async () => Math.round((await image.boundingBox())?.width ?? Infinity))
      .toBeLessThan(Math.round(fitWidth))
    expect((await image.boundingBox())!.width).toBeGreaterThan(
      (await canvas.boundingBox())!.width * 0.85,
    )
    await expect(canvas).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await page.screenshot({ path: test.info().outputPath('mermaid-viewer-light.png') })
  } finally {
    await shutdown(h)
  }
})

test('cancelling quit preserves active sessions and coalesces repeated quit requests', async () => {
  const h = await launch()
  try {
    const sessionId = await h.page.evaluate(async (workspacePath) => {
      const session = await window.phosphor.invoke('pi:createSession', { workspacePath })
      await window.phosphor.invoke('pi:command', session.sessionId, {
        type: 'prompt',
        message: 'queue-hold',
      })
      return session.sessionId
    }, h.workspace)
    await h.app.evaluate(({ app, dialog, BrowserWindow }) => {
      const state = globalThis as unknown as { quitPrompts: number; cancelQuit: () => void }
      state.quitPrompts = 0
      dialog.showMessageBox = () =>
        new Promise((resolve) => {
          state.quitPrompts++
          state.cancelQuit = () => resolve({ response: 0, checkboxChecked: false })
        })
      if (process.platform === 'darwin') app.quit()
      else BrowserWindow.getAllWindows()[0]!.close()
      app.quit()
    })
    await expect
      .poll(() =>
        h.app.evaluate(() => (globalThis as unknown as { quitPrompts: number }).quitPrompts),
      )
      .toBe(1)
    await h.app.evaluate(() => (globalThis as unknown as { cancelQuit: () => void }).cancelQuit())
    expect(h.page.isClosed()).toBe(false)
    const alive = await h.page.evaluate(
      (id) => window.phosphor.invoke('pi:command', id, { type: 'get_state' }),
      sessionId,
    )
    expect(alive.success).toBe(true)
    const another = await h.page.evaluate(
      (workspacePath) => window.phosphor.invoke('pi:createSession', { workspacePath }),
      h.workspace,
    )
    expect(another.sessionId).not.toBe(sessionId)
  } finally {
    await shutdown(h)
  }
})

test('bundled fonts render offline before editor or terminal initialization', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await page.context().setOffline(true)
    await page.reload()
    await openWorkspace(page)
    expect(
      await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length),
    ).toBe(4)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    for (const token of ['--px-font-sans', '--px-font-mono']) {
      await page.evaluate((name) => {
        document.getElementById('font-probe')?.remove()
        const probe = document.createElement('span')
        probe.id = 'font-probe'
        probe.style.cssText = 'position:fixed;top:0;left:0;z-index:99999'
        probe.style.fontFamily = `var(${name})`
        probe.textContent = 'Read Il10 code'
        document.body.append(probe)
      }, token)
      await expect(page.locator('#font-probe')).toBeVisible()
      const { root } = await cdp.send('DOM.getDocument')
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '#font-probe',
      })
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      expect(
        fonts.some((font) => font.isCustomFont && font.glyphCount > 0),
        JSON.stringify({ token, fonts }),
      ).toBe(true)
    }
  } finally {
    await shutdown(harness)
  }
})

test('Changes supports keyboard open/back and live diff font preferences', async () => {
  const harness = await launch()
  const { page, workspace } = harness
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    const before = await readFile(join(workspace, 'hello.ts'), 'utf8')
    await page.getByRole('button', { name: /Changes pane/ }).click()
    const row = page.getByRole('button', { name: 'View diff for hello.ts' })
    await row.focus()
    await row.press('Enter')
    const back = page.getByRole('button', { name: 'Back to changed files' })
    await expect(back).toBeFocused()
    const lines = page.locator('.monaco-diff-editor .view-lines').first()
    await expect(lines).toHaveCSS('font-size', '12.5px')

    await page.getByRole('button', { name: /^Settings/ }).click()
    const sizeRow = page.getByText('Editor font size', { exact: true }).locator('..').locator('..')
    await sizeRow.getByRole('spinbutton').fill('18')
    await page.getByRole('combobox', { name: 'Mono font' }).selectOption('Menlo')
    await page.keyboard.press('Escape')
    await expect(lines).toHaveCSS('font-size', '18px')
    await expect(lines).toHaveCSS('font-family', /^Menlo,/)
    await back.focus()
    await back.press('Enter')
    await expect(row).toBeFocused()
    await row.press('Space')
    await expect(back).toBeFocused()
    await expect(lines).toHaveCSS('font-size', '18px')
    await expect(lines).toHaveCSS('font-family', /^Menlo,/)
    expect(dialogs).toEqual([])
    expect(await readFile(join(workspace, 'hello.ts'), 'utf8')).toBe(before)
  } finally {
    await shutdown(harness)
  }
})

test('session chrome stays readable with long labels, laptop widths and zoom', async () => {
  const harness = await launch()
  const { page, app } = harness
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('session-row').first().dblclick()
    const longTitle =
      'Investigate reconnect recovery without losing the current session or unsent draft'
    await page.getByRole('textbox', { name: 'Session name' }).fill(longTitle)
    await page.getByRole('textbox', { name: 'Session name' }).press('Enter')
    await expect(page.getByTestId('session-title').first()).toHaveText(longTitle)
    await page.getByRole('button', { name: /Changes pane/ }).click()

    for (const [theme, width, zoom] of [
      ['Light', 1440, 1],
      ['Dark', 1000, 1],
      ['Light', 1000, 1.25],
      ['Dark', 1440, 1.5],
    ] as const) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
      )
      await page.getByRole('button', { name: /^Settings/ }).click()
      await page.getByRole('button', { name: theme, exact: true }).click()
      await page.keyboard.press('Escape')
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]!
          win.setContentSize(size.width, 740)
          win.webContents.setZoomFactor(size.zoom)
        },
        { width, zoom },
      )
      // Deliberately synthetic long model label: exercise layout, not a provider.
      await page
        .getByTestId('model-chip')
        .getByTestId('model-label')
        .evaluate((el) => {
          el.textContent = 'long-model-identifier-without-breaks'.repeat(3)
        })
      const field = page.getByPlaceholder(/Describe a task…/i)
      await expect(field).toBeVisible()
      // An empty composer is one line at every width: the placeholder's hints
      // are clipped, never wrapped into a second row.
      const fieldMetrics = await field.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(el).lineHeight),
      }))
      expect(fieldMetrics.height).toBeLessThan(2 * fieldMetrics.line)
      const card = await field.locator('..').boundingBox()
      expect(card).not.toBeNull()
      expect(card!.x + card!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
      for (const control of [
        page.getByRole('button', { name: 'Attach files', exact: true }),
        page.getByRole('button', { name: 'Send message', exact: true }),
        page.getByTestId('model-chip'),
      ]) {
        await expect(control).toBeVisible()
        const box = (await control.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(card!.x - 1)
        expect(box.x + box.width).toBeLessThanOrEqual(card!.x + card!.width + 1)
        expect(box.height).toBeGreaterThanOrEqual(32)
      }
      // The chip is one line at every width: a name that does not fit
      // truncates rather than growing the footer a row.
      const chip = await page.getByTestId('model-chip').evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        line: el.querySelector('[data-testid="model-label"]')!.getBoundingClientRect().height,
      }))
      expect(chip.height).toBeLessThan(2 * chip.line)
      const switcher = page
        .getByTestId('right-pane')
        .getByRole('group', { name: 'Pane', exact: true })
      expect(await switcher.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const title = page.getByTestId('session-title').first()
      await expect(title).toHaveCSS('text-overflow', 'ellipsis')
      const dims = await title.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(el).lineHeight),
        overflowing: el.scrollWidth > el.clientWidth,
      }))
      // One line at every width, even when the label is far too long for it.
      expect(dims.height).toBeLessThanOrEqual(dims.line + 1)
      expect(dims.overflowing).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      // capturePage uses native window dimensions; CDP screenshots crop at Electron zoom.
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage())
          .toPNG()
          .toString('base64'),
      )
      await writeFile(
        test.info().outputPath(`session-${theme}-${width}-${zoom}.png`),
        Buffer.from(png, 'base64'),
      )
    }
  } finally {
    await shutdown(harness)
  }
})

test('the / menu offers pi commands on the home screen and in a session', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    const field = page.getByPlaceholder('Describe a task or ask a question')
    // The list comes from a throwaway `pi --mode rpc --no-session`, not from a
    // session: this screen has none yet. Until it answers, the menu says so.
    await field.pressSequentially('/')
    const menu = page.getByRole('listbox', { name: 'Slash commands' })
    await expect(menu).toBeVisible()
    // Every command pi resolves is reachable: the stub answers more than 12
    // (one fewer row once `/ws` folds into `/web-status`), and this last one
    // sat past the cap of 12 the list used to have.
    await expect(page.getByText('Draft release notes from the git log')).toBeVisible({
      timeout: 30_000,
    })
    // Browsing is grouped; the alias is gone from the rows but not from the tooltip.
    await expect(menu.getByText('Extensions', { exact: true })).toBeVisible()
    await expect(menu.getByText('Prompts', { exact: true })).toBeVisible()
    await expect(menu.getByText('/ws', { exact: true })).toHaveCount(0)
    await expect(menu.locator('[data-tooltip*="Also: /ws"]')).toBeVisible()
    // The origin column answers "where is this from?" for a package command.
    await expect(menu.getByText('pi-web-access', { exact: true }).first()).toBeVisible()

    await field.pressSequentially('stub')
    // Matched on the description: the command's own name also appears in the
    // textarea's value once it is picked, which `getByText` would resolve to.
    const row = page.getByText('A stub command')
    await expect(row).toBeVisible()
    // Enter picks rather than sending, and leaves room for arguments.
    await field.press('Enter')
    await expect(field).toHaveValue('/stub-command ')
    await expect(row).toBeHidden()

    // Same menu, same keymap, in the session composer — where the list comes
    // from the session's own pi instead.
    await field.fill('Update hello.ts')
    await field.press('Enter')
    const chat = page.getByPlaceholder(/Describe a task…/i)
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    // Nothing matches: the menu stays up and says what Enter would do, rather
    // than vanishing as if it were broken.
    await chat.pressSequentially('/zzz')
    await expect(page.getByTestId('command-menu-empty')).toContainText('No command matches /zzz')
    await chat.fill('')
    // A word that appears in no name finds the commands whose description says it.
    await chat.pressSequentially('/reconnect')
    await expect(page.getByText(/Manage MCP servers/)).toBeVisible()
    await chat.fill('')
    await chat.pressSequentially('/stub')
    await expect(row).toBeVisible()
    await chat.press('Escape')
    await expect(row).toBeHidden()
    await expect(chat).toHaveValue('/stub')
  } finally {
    await shutdown(harness)
  }
})

test('composer formatting participates in native undo and redo', async () => {
  const harness = await launch()
  const { page } = harness
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await openWorkspace(page)
    const field = page.getByPlaceholder('Describe a task or ask a question')
    await field.pressSequentially('hello')
    await field.press(`${mod}+a`)
    await field.press(`${mod}+b`)
    await expect(field).toHaveValue('**hello**')
    await field.press(`${mod}+z`)
    await expect(field).toHaveValue('hello')
    await field.press(`${mod}+Shift+z`)
    await expect(field).toHaveValue('**hello**')
    await field.press('Enter')
    const chat = page.getByPlaceholder(/Describe a task…/i)
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await chat.pressSequentially('another prompt')
    await chat.press(`${mod}+a`)
    await chat.press(`${mod}+i`)
    await expect(chat).toHaveValue('_another prompt_')
    await chat.press(`${mod}+z`)
    await expect(chat).toHaveValue('another prompt')
    await chat.fill('漢字')
    await chat.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    await expect(chat).toHaveValue('漢字')
  } finally {
    await shutdown(harness)
  }
})

test('text fields get a right-click menu, and composers learn autocomplete @system-clipboard', async () => {
  const harness = await launch()
  const { page, app } = harness
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await openWorkspace(page)
    const home = page.getByPlaceholder('Describe a task or ask a question')
    const menu = page.getByTestId('context-menu')

    // Electron has no menu of its own: Paste and Select all run in main, on
    // the field that was right-clicked.
    await app.evaluate(({ clipboard }) => clipboard.writeText('pasted from the menu'))
    await home.click({ button: 'right' })
    await expect(menu.getByRole('button', { name: 'Cut' })).toBeDisabled()
    await menu.getByRole('button', { name: 'Paste' }).click()
    await expect(home).toHaveValue('pasted from the menu')
    await home.click({ button: 'right' })
    await menu.getByRole('button', { name: 'Select all' }).click()
    await expect
      .poll(() => home.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([0, 'pasted from the menu'.length])

    // macOS: the system spellchecker answers synchronously, so the fix is
    // deterministic there. Hunspell (Windows, Linux) downloads its
    // dictionary first, so it is not asserted.
    if (process.platform === 'darwin') {
      await home.fill('recieve')
      await home.click({ button: 'right', position: { x: 30, y: 22 } })
      await menu.getByRole('button', { name: 'receive', exact: true }).click()
      await expect(home).toHaveValue('receive')
      // A re-render writes React's state back to the DOM; the fix must be in it.
      await home.press(`${mod}+Shift+x`)
      await home.press(`${mod}+Shift+x`)
      await expect(home).toHaveValue('receive')
      await home.press(`${mod}+z`)
      await expect(home).toHaveValue('recieve')
    }
    await home.fill('')

    // Autocomplete is off until Settings → Writing turns it on.
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Writing', exact: true }).click()
    const toggle = page
      .locator('[data-setting-row]')
      .filter({ has: page.getByText('Autocomplete', { exact: true }) })
      .getByRole('switch')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')

    await home.fill('please review the diff for regressions')
    await home.press('Enter')
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    const chat = page.getByPlaceholder(/Describe a task…/i)
    await chat.pressSequentially('please review th')
    await expect(page.getByTestId('composer-suggestion')).toContainText('e diff for regressions')
    await chat.press('Tab')
    await expect(chat).toHaveValue('please review the diff for regressions')

    // A suggestion longer than the line: only what fits is shown, and Tab
    // inserts only what was shown.
    const long =
      'please check the extraordinarily complicated synchronization implementation ' +
      'regarding internationalization considerations thoroughly'
    await chat.fill(long)
    await chat.press('Enter')
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toHaveCount(2, {
      timeout: 30_000,
    })
    await chat.pressSequentially('please check the ext')
    const ghost = page.getByTestId('composer-suggestion').locator('span').last()
    await expect(ghost).toBeVisible()
    const shown = (await ghost.textContent()) ?? ''
    const ghostBox = (await ghost.boundingBox())!
    const fieldBox = (await chat.boundingBox())!
    expect(ghostBox.y + ghostBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height + 1)
    expect(long.startsWith('please check the ext' + shown)).toBe(true)
    expect(shown.length).toBeLessThan(long.length - 'please check the ext'.length)
    await chat.press('Tab')
    await expect(chat).toHaveValue('please check the ext' + shown)

    // Learned in main, where it survives a restart.
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    await expect
      .poll(() => readFile(join(userData, 'writing', 'prompts.jsonl'), 'utf8').catch(() => ''))
      .toContain('please review the diff for regressions')
  } finally {
    await shutdown(harness)
  }
})

test('composer shortcuts format selections, insert links and expand long drafts', async () => {
  const harness = await launch()
  const { page } = harness
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await openWorkspace(page)
    const field = page.getByPlaceholder('Describe a task or ask a question')
    await field.fill('read more')
    await field.press(`${mod}+a`)
    await field.press(`${mod}+b`)
    await expect(field).toHaveValue('**read more**')
    await expect(field).toBeFocused()
    await field.press(`${mod}+z`)
    await expect(field).toHaveValue('read more')
    await field.press(`${mod}+a`)
    await field.press(`${mod}+Shift+k`)
    await expect(field).toHaveValue('[read more](https://)')
    await expect(field).toBeFocused()
    expect(
      await field.evaluate((el: HTMLTextAreaElement) =>
        el.value.slice(el.selectionStart, el.selectionEnd),
      ),
    ).toBe('https://')
    await field.pressSequentially('https://example.com')
    await expect(field).toHaveValue('[read more](https://example.com)')

    const draft = Array.from({ length: 30 }, (_, i) => `Review item ${i + 1}`).join('\n')
    await field.fill(draft)
    const compact = (await field.boundingBox())!.height
    await field.press(`${mod}+Shift+x`)
    const expanded = (await field.boundingBox())!.height
    expect(expanded).toBeGreaterThan(compact)
    expect(expanded).toBeLessThanOrEqual(await page.evaluate(() => innerHeight / 2))
    await expect(field).toHaveValue(draft)
    await page.screenshot({ path: test.info().outputPath('expanded-home-input.png') })
    await field.press(`${mod}+Shift+x`)
    await expect.poll(async () => (await field.boundingBox())!.height).toBe(compact)
    await expect(field).toHaveValue(draft)
    await field.fill('Update hello.ts')
    await field.press('Enter')
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    const chat = page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('review code')
    await chat.press(`${mod}+a`)
    await chat.press(`${mod}+e`)
    await expect(chat).toHaveValue('`review code`')
    // The composer stays two rows: the field and its footer, no toolbar strip.
    await expect(page.locator('[aria-label="Text formatting"]')).toHaveCount(0)
    await chat.press(`${mod}+/`)
    const formatting = page.getByRole('heading', { name: 'Formatting', exact: true })
    await formatting.scrollIntoViewIfNeeded()
    await expect(formatting).toBeInViewport()
  } finally {
    await shutdown(harness)
  }
})

test('work-area shortcuts work from chat without stealing dialog or editor input', async () => {
  const harness = await launch()
  const { page } = harness
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await openWorkspace(page)
    const home = page.getByRole('textbox', { name: 'Chat message' })
    await home.fill('Update hello.ts')
    await home.press(`${mod}+p`)
    const finder = page.getByPlaceholder('Go to file…')
    await expect(finder).toBeFocused()
    await finder.press('F6')
    await expect(finder).toBeFocused()
    await finder.press('Escape')
    await page.keyboard.press('F6')
    await expect(home).toBeFocused()
    await home.press('Enter')
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    const chat = page.getByRole('textbox', { name: 'Chat message' })
    await chat.fill('preserved draft')
    await chat.press(`${mod}+Shift+g`)
    const pane = page.getByTestId('right-pane')
    await expect(page.getByRole('button', { name: 'View diff for hello.ts' })).toBeVisible()
    await chat.press('F6')
    await expect(pane.getByRole('button', { name: 'Files', exact: true })).toBeFocused()
    await page.keyboard.press('F6')
    await expect(chat).toBeFocused()
    await chat.press(`${mod}+Shift+e`)
    await expect(pane.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await chat.press(`${mod}+p`)
    await finder.fill('hello.ts')
    await expect(
      page.locator('[data-shortcut-overlay="finder"]').getByText('hello.ts', { exact: true }),
    ).toBeVisible()
    await finder.press('Enter')
    const editor = page.locator('.monaco-editor textarea').first()
    await editor.focus()
    await editor.press(`${mod}+b`)
    await expect(page.getByTestId('workspace-group').first()).toBeVisible()
    await editor.press('F6')
    await expect(chat).toBeFocused()
    await chat.press(`${mod}+,`)
    const size = page
      .getByText('Editor font size', { exact: true })
      .locator('..')
      .locator('..')
      .getByRole('spinbutton')
    await size.focus()
    await size.press('F6')
    await expect(size).toBeFocused()
    await size.press(`${mod}+Shift+g`)
    await expect(pane.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await size.press('Escape')
    await page.keyboard.press('F6')
    await chat.press(`${mod}+n`)
    await expect(page.getByPlaceholder('Describe a task or ask a question')).toBeVisible()
    await page.getByTestId('session-row').first().click()
    await expect(chat).toHaveValue('preserved draft')
    await chat.press(`${mod}+Backquote`)
    await expect(page.locator('.xterm')).toBeVisible()
    await page.locator('.xterm-helper-textarea').press(`${mod}+f`)
    await page.keyboard.press('F6')
    await page.waitForTimeout(60) // Cross the terminal search's 30ms focus timer.
    await expect(chat).toBeFocused()
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await expect(page.getByTestId('global-page')).toBeVisible()
    await page.keyboard.press('F6')
    await expect(page.getByTestId('global-page')).toBeHidden()
    await expect(chat).toBeFocused()
    await page.getByRole('button', { name: 'Fullscreen pane', exact: true }).click()
    await page.keyboard.press('F6')
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeFocused()
  } finally {
    await shutdown(harness)
  }
})

test('steering controls and modified Enter send the intended RPC mode', async () => {
  const workspace = await scratchDir('phosphor-queue-')
  const log = join(workspace, 'commands.jsonl')
  const harness = await launch({ workspace, env: { PHOSPHOR_E2E_COMMAND_LOG: log } })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('queue-hold')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    const chat = page.getByRole('textbox', { name: 'Chat message' })
    const steer = page.getByRole('button', { name: 'Steer now' })
    // No empty-draft row: the controls arrive with something to send.
    await expect(steer).toBeHidden()
    await chat.fill('steer this')
    await steer.click()
    await expect(chat).toBeFocused()
    await expect(steer).toBeHidden()
    await chat.fill('after this')
    await page.getByRole('button', { name: 'Queue follow-up' }).click()
    await chat.fill('keyboard follow-up')
    await chat.press('Control+Enter')
    await expect
      .poll(async () =>
        (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as { type: string; message?: string; streamingBehavior?: string },
          )
          .filter((cmd) => cmd.type === 'prompt' && cmd.message !== 'queue-hold')
          .map((cmd) => cmd.streamingBehavior),
      )
      .toEqual(['steer', 'followUp', 'followUp'])
    // Queued messages stay out of the transcript until pi delivers them;
    // a bubble at send time sat above work the agent did before reading it.
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    await expect(page.getByTestId('user-message')).toHaveText('queue-hold')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Steer now' })).toBeHidden()
  } finally {
    await shutdown(harness)
  }
})

test('Agent settings persist a validated context budget', async () => {
  const harness = await launch()
  const { page } = harness
  const budget = () =>
    page.evaluate(async () => (await window.phosphor.invoke('app:getPrefs')).contextBudget)
  try {
    await openWorkspace(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    const custom = page.getByRole('textbox', { name: 'Custom context budget' })
    await custom.fill('500')
    await expect(page.getByText('= 500k tokens')).toBeVisible()
    await custom.press('Enter')
    await expect.poll(budget).toBe('500')
    await custom.fill('77k')
    await custom.press('Enter')
    await expect(
      page.getByText('Use a budget from 100k to 1M (e.g. 300k), auto, or off.'),
    ).toBeVisible()
    expect(await budget()).toBe('500')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Custom context budget' })).toHaveValue('500')
    await page.getByRole('radio', { name: /^Default: 200k tokens/ }).click()
    await expect.poll(budget).toBe('')
  } finally {
    await shutdown(harness)
  }
})

test('Codex context popover reads account usage and refreshes through main', async () => {
  const harness = await launch({ env: { PHOSPHOR_E2E_MODEL_PROVIDER: 'openai-codex' } })
  const { page, app } = harness
  try {
    // Stub only the HTTP boundary. The real IPC, pi auth subprocess, parser,
    // cache and renderer run together, without a real credential or network.
    await app.evaluate(() => {
      let reads = 0
      const original = globalThis.fetch
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://chatgpt.com/backend-api/wham/usage') return original(url, options)
        const headers = new Headers(options?.headers)
        if (headers.get('ChatGPT-Account-Id') !== 'stub-account') throw new Error('Wrong account')
        reads++
        return new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: reads === 1 ? 48 : 49,
                limit_window_seconds: 604800,
                reset_at: Date.now() / 1000 + 86400,
              },
            },
            spend_control: {
              individual_limit: { unit: 'credit', limit: '200', remaining: '56.15' },
            },
          }),
        )
      }
    })
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await page.locator('button[data-tooltip^="Context:"]').click()
    await expect(page.getByText('Plan usage · ChatGPT account')).toBeVisible()
    await expect(page.locator('[data-tooltip^="Weekly window — 48% used"]')).toBeVisible()
    await expect(page.getByText('56.2 of 200 credits left')).toBeVisible()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('[data-tooltip^="Weekly window — 49% used"]')).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

// Once as a plain pi session and once as a Claude Code one: pi owns
// compaction on every provider, and most Claude models have a 1M window.
for (const provider of ['stub', 'pi-claude-cli'] as const) {
  test(`a large-window ${provider} session over the context budget compacts, holding the next prompt`, async () => {
    // A 1M-window model whose context holds 250k after each turn: over the
    // default 200k budget, far under pi's own ~984k line. pi rejects a prompt
    // sent during a requested compaction, so the second message only runs if
    // `pi:command` held it until the compaction finished.
    const workspace = await scratchDir('phosphor-budget-')
    const log = join(workspace, 'commands.jsonl')
    const harness = await launch({
      workspace,
      env: {
        PHOSPHOR_E2E_COMMAND_LOG: log,
        PHOSPHOR_E2E_CONTEXT_WINDOW: '1000000',
        PHOSPHOR_E2E_CONTEXT_TOKENS: '250000',
        PHOSPHOR_E2E_COMPACT_MS: '2000',
        PHOSPHOR_E2E_MODEL_PROVIDER: provider,
      },
    })
    const { page } = harness
    const sent = async (): Promise<string[]> =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { type: string }).type)
        .filter((type) => type === 'prompt' || type === 'compact')
    try {
      await openWorkspace(page)
      await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
      await page.getByRole('button', { name: /Start session/i }).click()
      await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

      // The budget check runs once the turn settles.
      await expect(page.getByText('compacting…')).toBeVisible()
      await expect.poll(sent).toEqual(['prompt', 'compact'])

      // Sent mid-compaction: held, not rejected.
      const chat = page.getByRole('textbox', { name: 'Chat message' })
      await chat.fill('and again')
      await chat.press('Enter')
      await expect(
        page.getByText(/Context compacted — 250k tokens summarized/).first(),
      ).toBeVisible()
      await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toHaveCount(2, {
        timeout: 30_000,
      })
      await expect(page.getByText(/Cannot submit a prompt/)).toHaveCount(0)
      expect((await sent()).slice(0, 3)).toEqual(['prompt', 'compact', 'prompt'])
    } finally {
      await shutdown(harness)
    }
  })
}

test('a session within its window and the budget is never compacted by Phosphor', async () => {
  // The stub's default 200k window is no larger than the budget, so pi's own
  // threshold governs even with a context near the top of it.
  const workspace = await scratchDir('phosphor-budget-small-')
  const log = join(workspace, 'commands.jsonl')
  const harness = await launch({
    workspace,
    env: { PHOSPHOR_E2E_COMMAND_LOG: log, PHOSPHOR_E2E_CONTEXT_TOKENS: '190000' },
  })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    // The check ran (it reads get_state after the turn settles) and stopped there.
    await expect
      .poll(async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).length)
      .toBeGreaterThan(0)
    await page.waitForTimeout(500)
    const types = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type)
    expect(types).not.toContain('compact')
  } finally {
    await shutdown(harness)
  }
})

test('workspace → session → streamed answer, diff and artifact render', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()

    // Streamed assistant text.
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    // The settled activity run collapses to a summary; expand it.
    await page.getByTestId('activity-summary').first().click()

    // Edit tool card with its diff.
    const editRow = page
      .getByTestId('activity-group')
      .getByRole('button', { name: /Edited\s+hello\.ts/ })
    await expect(editRow).toBeVisible()
    await editRow.click()
    await expect(page.getByText('return "new"').first()).toBeVisible()

    // Files Changed panel.
    await page.getByRole('button', { name: /Changes pane/ }).click()
    await expect(page.getByText('Files changed')).toBeVisible()
    await expect(page.getByText('hello.ts').first()).toBeVisible()

    // Artifacts pane got the artifact from the tool result.
    await page.getByRole('button', { name: 'Artifacts pane', exact: true }).click()
    await expect(page.getByText('E2E Card').first()).toBeVisible({ timeout: 10_000 })

    // The global Artifacts page (sidebar row) indexes it across sessions…
    await page.getByRole('button', { name: 'Artifacts', exact: true }).click()
    const globalPage = page.getByTestId('global-page')
    await expect(globalPage.getByText('Everything your sessions have produced')).toBeVisible()
    const row = globalPage.getByRole('button', { name: /E2E Card/ })
    await expect(row).toBeVisible()

    // …and opening a row jumps back into the session with the pane on it.
    await row.click()
    await expect(globalPage).not.toBeVisible()
    await expect(page.getByTestId('right-pane').getByText('E2E Card').first()).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('file finder reveals and highlights a nested file in the explorer', async () => {
  const harness = await launch()
  const { page, workspace } = harness
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await mkdir(join(workspace, 'src', 'nested'), { recursive: true })
    await writeFile(join(workspace, 'src', 'nested', 'target.ts'), 'export const target = 1\n')
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        writeFile(join(workspace, 'src', 'nested', `before-${i}.ts`), ''),
      ),
    )
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    // The finder must restore the tree even when content search was showing.
    await page.keyboard.press(`${mod}+Shift+f`)
    await expect(page.getByTestId('workspace-search')).toBeVisible()
    await page.getByRole('textbox', { name: 'Chat message' }).focus()
    await page.keyboard.press(`${mod}+p`)
    const finder = page.getByPlaceholder('Go to file…')
    await expect(finder).toBeFocused()
    await finder.fill('target.ts')
    await expect(
      page.locator('[data-shortcut-overlay="finder"]').getByText('target.ts', { exact: true }),
    ).toBeVisible()
    await finder.press('Enter')
    const explorer = page.getByTestId('file-explorer')
    const target = explorer.getByRole('button', { name: 'target.ts', exact: true })
    await expect(target).toHaveAttribute('aria-current', 'true')
    await expect(target).toHaveAttribute('aria-pressed', 'true')
    await expect(target).toBeInViewport()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('export const target')
    await target.focus()
    await target.press('ArrowLeft')
    const parent = explorer.getByRole('button', { name: 'nested', exact: true })
    await expect(parent).toBeFocused()
    await parent.press('ArrowRight')
    await expect(explorer.getByRole('button', { name: 'before-0.ts', exact: true })).toBeFocused()
    await explorer.getByRole('button', { name: 'Collapse all folders', exact: true }).click()
    await expect(target).not.toBeVisible()
    await explorer.getByRole('button', { name: 'Reveal active file', exact: true }).click()
    await expect(target).toBeInViewport()
    await explorer.getByRole('button', { name: 'src', exact: true }).click()
    await expect(target).not.toBeVisible()
    await page.keyboard.press(`${mod}+p`)
    await expect(finder).toBeFocused()
    await finder.fill('target.ts')
    await expect(
      page.locator('[data-shortcut-overlay="finder"]').getByText('target.ts', { exact: true }),
    ).toBeVisible()
    await finder.press('Enter')
    await expect(target).toHaveAttribute('aria-pressed', 'true')
    await expect(target).toBeInViewport()
    const editor = page.locator('.monaco-editor [role="textbox"]').first()
    await editor.focus()
    await editor.press(`${mod}+p`)
    await expect(finder).toBeFocused()
    await finder.fill('target.ts:1:14')
    await expect(page.getByRole('option', { name: /target.ts/ })).toBeVisible()
    await finder.press('Enter')
    await expect(editor).toBeFocused()
    await page.keyboard.type('/*here*/')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('/*here*/target')
    await editor.press(`${mod}+p`)
    await expect(finder).toBeFocused()
    await finder.press('Escape')
    await expect(editor).toBeFocused()
  } finally {
    await shutdown(harness)
  }
})

test('Changes revert restores working content without changing staged edits', async () => {
  const harness = await launch()
  const { page, workspace } = harness
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    await run('git', ['init', '-b', 'main'], { cwd: workspace })
    await run('git', ['config', 'user.email', 'test@phosphor.dev'], { cwd: workspace })
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace })
    await run('git', ['add', '.'], { cwd: workspace })
    await run('git', ['commit', '-m', 'initial'], { cwd: workspace })
    const original = await readFile(join(workspace, 'hello.ts'), 'utf8')
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    const lane = join(workspace, '.phosphor', 'worktrees', 'hello')
    expect(existsSync(lane)).toBe(true)
    await writeFile(join(lane, 'hello.ts'), '// staged\n')
    await run('git', ['add', 'hello.ts'], { cwd: lane })
    await writeFile(join(lane, 'hello.ts'), '// unstaged\n')
    await page.getByRole('button', { name: /Changes pane/ }).click()
    await page.getByRole('button', { name: 'Revert hello.ts', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Revert', exact: true }).click()
    await expect.poll(() => readFile(join(lane, 'hello.ts'), 'utf8')).toBe(original)
    const staged = await run('git', ['show', ':hello.ts'], { cwd: lane })
    expect(staged.stdout).toBe('// staged\n')
  } finally {
    await shutdown(harness)
  }
})

test('closing dirty editor tabs offers cancel, discard and save', async () => {
  const harness = await launch()
  const { page, workspace } = harness
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Files pane/ }).click()
    const row = page
      .getByTestId('file-explorer')
      .getByRole('button', { name: 'hello.ts', exact: true })
    const editor = page.locator('.monaco-editor [role="textbox"]').first()
    const close = page.getByRole('button', { name: 'Close hello.ts', exact: true })
    const dialog = page.getByRole('dialog', { name: 'Save changes to hello.ts?' })
    await row.click()
    await editor.focus()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('// discard me')
    await close.click()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('discard me')
    await close.click()
    await dialog.getByRole('button', { name: 'Don’t Save', exact: true }).click()
    await expect(page.getByText('No file open', { exact: true })).toBeVisible()
    expect(await readFile(join(workspace, 'hello.ts'), 'utf8')).not.toContain('discard me')
    await row.click()
    await editor.focus()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('// save me')
    await close.click()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('No file open', { exact: true })).toBeVisible()
    expect(await readFile(join(workspace, 'hello.ts'), 'utf8')).toBe('// save me')
    await page.keyboard.press(`${mod}+Shift+t`)
    const helloTab = page.getByRole('tab', { name: /hello.ts/ })
    await expect(helloTab).toHaveAttribute('aria-selected', 'true')
    await writeFile(join(workspace, 'other.ts'), '// other')
    await page
      .getByTestId('file-explorer')
      .getByRole('button', { name: 'other.ts', exact: true })
      .click()
    const otherTab = page.getByRole('tab', { name: /other.ts/ })
    await editor.focus()
    await page.keyboard.press('Control+Tab')
    await expect(helloTab).toHaveAttribute('aria-selected', 'true')
    await helloTab.click({ button: 'right' })
    await page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Pin tab', exact: true })
      .click()
    await otherTab.click({ button: 'right' })
    await page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Close others', exact: true })
      .click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await otherTab.dragTo(helloTab)
    await expect(page.getByRole('tab').first()).toContainText('other.ts')
    await editor.focus()
    await page.keyboard.press(`${mod}+w`)
    await expect(helloTab).toHaveCount(0)
    await page.keyboard.press(`${mod}+Shift+t`)
    await expect(helloTab).toHaveAttribute('aria-selected', 'true')
    await editor.focus()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('// save all hello')
    await otherTab.click()
    await editor.focus()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('// save all other')
    await page.keyboard.press(`${mod}+Alt+s`)
    await expect.poll(() => readFile(join(workspace, 'hello.ts'), 'utf8')).toBe('// save all hello')
    await expect.poll(() => readFile(join(workspace, 'other.ts'), 'utf8')).toBe('// save all other')
    await page.getByRole('button', { name: 'Close hello.ts', exact: true }).click()
    await page.getByRole('button', { name: 'Close other.ts', exact: true }).click()
    await rm(join(workspace, 'other.ts'))
    await page.keyboard.press(`${mod}+Shift+t`)
    await expect(page.getByRole('list', { name: 'Notifications' })).toContainText('ENOENT')
    await page.keyboard.press(`${mod}+Shift+t`)
    await expect(helloTab).toHaveAttribute('aria-selected', 'true')
  } finally {
    await shutdown(harness)
  }
})

test('explorer creates entries from empty space and keeps renamed editor buffers', async () => {
  const harness = await launch()
  const { page, workspace } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await rm(join(workspace, 'hello.ts'))
    await page.getByRole('button', { name: /Files pane/ }).click()
    const explorer = page.getByTestId('file-explorer')
    await expect(explorer.getByText(/Empty folder/)).toBeVisible()
    await explorer.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.getByRole('textbox').last().fill('notes')
    await page.getByRole('button', { name: 'OK', exact: true }).click()
    await explorer.getByRole('button', { name: 'notes', exact: true }).click({ button: 'right' })
    await page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'New file…', exact: true })
      .click()
    await page.getByPlaceholder('Name', { exact: true }).fill('draft.md')
    await page.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(explorer.getByRole('button', { name: 'draft.md', exact: true })).toBeVisible()
    expect(await readFile(join(workspace, 'notes/draft.md'), 'utf8')).toBe('')
    const editor = page.locator('.monaco-editor [role="textbox"]').first()
    await editor.focus()
    await page.keyboard.type('unsaved notes')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('unsaved notes')
    await explorer.getByRole('button', { name: 'notes', exact: true }).click({ button: 'right' })
    await page.getByTestId('context-menu').getByRole('button', { name: 'Rename…' }).click()
    await page.getByRole('textbox').last().fill('docs')
    await page.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(page.locator('[data-tooltip="docs/draft.md"]')).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('unsaved notes')
    await editor.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect
      .poll(() => readFile(join(workspace, 'docs/draft.md'), 'utf8'))
      .toBe('unsaved notes')
    expect(existsSync(join(workspace, 'notes'))).toBe(false)
  } finally {
    await shutdown(harness)
  }
})

test('⌘F finds in the transcript, ⌘⇧F searches workspace files and opens the match', async () => {
  const workspace = await scratchDir('phosphor-e2e-search-')
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, 'src', 'deep.ts'), 'const a = 1\n\nexport const needle = a\n')
  await writeFile(join(workspace, 'notes.md'), '# A needle in the notes\n')
  await writeFile(join(workspace, 'blob.bin'), Buffer.from('needle\0\u0001'))
  const harness = await launch({ workspace })
  const { page } = harness
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    // ⌘F from the composer opens the transcript's find bar.
    await page.getByPlaceholder(/Describe a task…/i).focus()
    await page.keyboard.press(`${mod}+f`)
    const find = page.getByTestId('transcript-find')
    await expect(find).toBeVisible()
    await page.keyboard.type('updated')
    await expect(find.getByTestId('find-status')).toHaveText(/^1 of \d+/)
    await page.keyboard.press('Escape')
    await expect(find).not.toBeVisible()

    // ⌘⇧F opens the Files pane on the workspace search, field focused.
    await page.keyboard.press(`${mod}+Shift+f`)
    const search = page.getByTestId('workspace-search')
    await expect(search).toBeVisible()
    await expect(search.getByTestId('workspace-search-input')).toBeFocused()
    await page.keyboard.type('needle')
    const status = search.getByTestId('workspace-search-status')
    await expect(status).toContainText('2 results in 2 files')
    await expect(status).toContainText('1 file skipped')

    // Globs narrow it; a folder name includes everything under it.
    await search.getByRole('button', { name: 'Files to include or exclude' }).click()
    await search.getByPlaceholder(/e\.g\. src/).fill('src')
    await expect(status).toContainText('1 result in 1 file')
    const results = search.getByTestId('workspace-search-results')
    await expect(results.locator('[data-search-file="src/deep.ts"]')).toBeVisible()

    // Choosing a match opens the file with the match selected, focus left in the list.
    await results.locator('[data-search-line="3"]').click()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('export const needle')
    await expect(page.locator('.monaco-editor .selected-text').first()).toBeAttached()
    await expect(results).toBeFocused()
    // Enter goes on into the editor.
    await page.keyboard.press('Enter')
    await expect(page.locator('.monaco-editor [role="textbox"]').first()).toBeFocused()

    // Escape from the field goes back to the tree, which takes focus; the
    // search keeps its answer.
    await search.getByTestId('workspace-search-input').focus()
    await page.keyboard.press('Escape')
    const explorer = page.getByTestId('file-explorer')
    await expect(explorer).toBeFocused()
    await explorer.getByRole('button', { name: /^Search in files/ }).click()
    await expect(status).toContainText('1 result in 1 file')

    // The same walk by keyboard: ↓ into the list at the file, ↓ to its match,
    // Space opens it and leaves focus in the list.
    await expect(search.getByTestId('workspace-search-input')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(results).toBeFocused()
    await expect(results.locator('[data-search-file="src/deep.ts"]')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.keyboard.press('ArrowDown')
    const match = results.locator('[data-search-line="3"]')
    await expect(match).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Space')
    await expect(results).toBeFocused()
    // Escape steps back out: the list to the field, the field to the tree.
    await page.keyboard.press('Escape')
    await expect(search.getByTestId('workspace-search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(explorer).toBeFocused()

    // ✕ closes it the same way.
    await explorer.getByRole('button', { name: /^Search in files/ }).click()
    await search.getByRole('button', { name: 'Back to the explorer (Esc)' }).click()
    await expect(explorer).toBeFocused()
  } finally {
    await shutdown(harness)
  }
})

test('explorer follows external create, move and delete changes on disk', async () => {
  const workspace = await scratchDir('phosphor-e2e-files-watch-')
  await writeFile(join(workspace, 'clip.mp4'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(workspace, 'videos_stub_file'), '')
  const harness = await launch({ workspace })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Files pane/ }).click()

    const explorer = page.getByTestId('file-explorer')
    const row = (name: string) => explorer.getByRole('button', { name, exact: true })
    await expect(row('clip.mp4')).toBeVisible()
    await expect(row('videos_stub_file')).toBeVisible()
    await expect(explorer.getByRole('button', { name: 'Refresh explorer' })).toBeVisible()

    // New directories arrive through chokidar and render as folder rows. A
    // selection whose path still exists survives the directory patch.
    await row('clip.mp4').click()
    await mkdir(join(workspace, 'work', 'sheets'), { recursive: true })
    await expect(row('work')).toBeVisible({ timeout: 4_000 })
    await expect(row('work')).toHaveAttribute('data-directory', 'true')
    await expect(row('clip.mp4')).toHaveAttribute('aria-pressed', 'true')
    await row('work').click()
    await expect(row('sheets')).toBeVisible()
    await row('clip.mp4').click()

    // Moving a file patches both parents: it disappears from root and appears
    // under its new directory. The old selection clears with the old row.
    await mkdir(join(workspace, 'videos'))
    await rename(join(workspace, 'clip.mp4'), join(workspace, 'videos', 'clip.mp4'))
    await expect(row('videos')).toBeVisible({ timeout: 4_000 })
    await expect(row('clip.mp4')).toHaveCount(0)
    await expect(explorer).not.toContainText('1 selected')
    await row('videos').click()
    await expect(row('clip.mp4')).toBeVisible()

    await row('videos_stub_file').click()
    await rm(join(workspace, 'videos_stub_file'))
    await expect(row('videos_stub_file')).toHaveCount(0, { timeout: 4_000 })
    await expect(explorer).not.toContainText('1 selected')

    // Events emitted with the pane unmounted are repaired by the unconditional
    // mount refresh (and, independently, the directory-mtime polling fallback).
    await page.getByRole('button', { name: 'Changes', exact: true }).click()
    await mkdir(join(workspace, 'late'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(row('late')).toBeVisible({ timeout: 4_000 })

    await writeFile(join(workspace, 'manual-refresh.txt'), 'ready')
    await explorer.getByRole('button', { name: 'Refresh explorer' }).click()
    await expect(row('manual-refresh.txt')).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('explorer previews images, pages and PDFs, and refuses to launch programs', async () => {
  const workspace = await scratchDir('phosphor-e2e-files-preview-')
  // 1×1 PNG.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await writeFile(join(workspace, 'dot.png'), Buffer.from(png, 'base64'))
  await mkdir(join(workspace, 'site'))
  await writeFile(
    join(workspace, 'site', 'index.html'),
    '<link rel="stylesheet" href="style.css"><p id="out">static</p><p id="net">pending</p>' +
      '<script src="app.js"></script>',
  )
  await writeFile(join(workspace, 'site', 'style.css'), '#out { color: rgb(1, 2, 3) }')
  await writeFile(
    join(workspace, 'site', 'app.js'),
    "document.getElementById('out').textContent = 'script ran';" +
      "fetch('../.env').then(() => 'fetched', () => 'fetch blocked')" +
      ".then((r) => { document.getElementById('net').textContent = r })",
  )
  await writeFile(join(workspace, '.env'), 'SECRET=1')
  await writeFile(
    join(workspace, 'doc.pdf'),
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n',
  )
  await writeFile(join(workspace, 'Setup.exe'), Buffer.from([0x4d, 0x5a, 0, 0, 0]))
  await writeFile(join(workspace, 'data.bin'), Buffer.from([0, 1, 2, 3]))
  const harness = await launch({ workspace })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Files pane/ }).click()
    const explorer = page.getByTestId('file-explorer')
    const row = (name: string) => explorer.getByRole('button', { name, exact: true })

    await row('dot.png').click()
    await expect(page.locator('img[src^="phosphor-file://"]')).toBeVisible()
    await expect(page.getByText('1 × 1 · 70 B')).toBeVisible()

    // The page loads its own CSS and script, but cannot read a sibling file.
    await row('site').click()
    await row('index.html').click()
    const frame = page.frameLocator('iframe[title="index.html"]')
    await expect(frame.locator('#out')).toHaveText('script ran')
    await expect(frame.locator('#out')).toHaveCSS('color', 'rgb(1, 2, 3)')
    await expect(frame.locator('#net')).toHaveText('fetch blocked')
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('stylesheet')

    await row('doc.pdf').click()
    await expect(page.locator('iframe[title="doc.pdf"]')).toHaveAttribute(
      'src',
      /^phosphor-file:\/\/[0-9a-f]{32}\/doc\.pdf/,
    )

    await row('data.bin').click()
    await expect(page.getByText('No preview for .bin files.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open in default app' })).toBeVisible()

    await row('Setup.exe').click()
    await page.getByRole('button', { name: 'Open in default app' }).click()
    await expect(page.getByText(/Setup\.exe would run a program if opened/)).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('explorer copies, cuts, multi-drags and imports disk-backed files @system-clipboard', async () => {
  const harness = await launch()
  const { page, workspace, app } = harness
  const external = await scratchDir('phosphor-drop-')
  const source = join(external, 'report.pdf')
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await mkdir(join(workspace, 'destination'))
    await mkdir(join(workspace, 'moved'))
    await writeFile(join(workspace, 'a.txt'), 'a')
    await writeFile(join(workspace, 'b.txt'), 'b')
    await writeFile(source, Buffer.from([0, 255, 1, 2]))
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Files pane/ }).click()
    const explorer = page.getByTestId('file-explorer')
    const row = (name: string) => explorer.getByRole('button', { name, exact: true })
    await row('hello.ts').click()
    await expect(row('hello.ts')).toHaveAttribute('aria-pressed', 'true')
    await expect(row('hello.ts')).toBeFocused()
    await page.keyboard.press(`${mod}+x`)
    await expect
      .poll(() => page.evaluate(() => window.phosphor.invoke('clipboard:readFiles')))
      .toEqual({ paths: [join(workspace, 'hello.ts')], cut: true })
    await row('destination').click()
    await page.keyboard.press(`${mod}+v`)
    await expect.poll(() => existsSync(join(workspace, 'destination/hello.ts'))).toBe(true)
    await expect(explorer).toHaveAttribute('aria-busy', 'false')
    expect(existsSync(join(workspace, 'hello.ts'))).toBe(false)
    await expect(page.locator('[data-tooltip="destination/hello.ts"]')).toBeVisible()

    await row('destination').click({ button: 'right' })
    await page
      .getByTestId('context-menu')
      .getByRole('button', { name: /^Copy (⌘C|Ctrl\+C)$/ })
      .click()
    await expect
      .poll(() => page.evaluate(() => window.phosphor.invoke('clipboard:readFiles')))
      .toEqual({ paths: [join(workspace, 'destination')], cut: false })
    await explorer.click({ button: 'right', position: { x: 10, y: 350 } })
    await page
      .getByTestId('context-menu')
      .getByRole('button', { name: /^Paste / })
      .click()
    await expect.poll(() => existsSync(join(workspace, 'destination copy/hello.ts'))).toBe(true)
    await expect(explorer).toHaveAttribute('aria-busy', 'false')

    await row('a.txt').click()
    await row('b.txt').click({ modifiers: [mod] })
    await expect(row('a.txt')).toHaveAttribute('aria-pressed', 'true')
    await expect(row('b.txt')).toHaveAttribute('aria-pressed', 'true')
    await row('a.txt').dragTo(row('moved'))
    await expect.poll(() => existsSync(join(workspace, 'moved/b.txt'))).toBe(true)
    expect(await readFile(join(workspace, 'moved/a.txt'), 'utf8')).toBe('a')
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)
    await expect(explorer).toHaveAttribute('aria-busy', 'false')

    // Real disk-backed File: exercises preload's webUtils path extraction, not a forged path.
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'drop-fixture'
      document.body.append(input)
    })
    await page.locator('#drop-fixture').setInputFiles(source)
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(document.querySelector<HTMLInputElement>('#drop-fixture')!.files![0]!)
      document
        .querySelector('[data-testid="file-explorer"]')!
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      document.querySelector('#drop-fixture')!.remove()
    })
    // A copy creates the file before its bytes land, so wait for the content itself.
    const expected = await readFile(source)
    await expect
      .poll(() => readFile(join(workspace, 'report.pdf')).catch(() => Buffer.alloc(0)))
      .toEqual(expected)
    await expect(explorer).toHaveAttribute('aria-busy', 'false')

    // Seed the native OS file-list format, then paste through the focused explorer.
    await app.evaluate(
      ({ clipboard }, { source, url }) => {
        if (process.platform === 'darwin')
          clipboard.writeBuffer(
            'NSFilenamesPboardType',
            Buffer.from(
              `<?xml version="1.0"?><plist version="1.0"><array><string>${source}</string></array></plist>`,
            ),
          )
        else if (process.platform === 'win32') {
          const header = Buffer.alloc(20)
          header.writeUInt32LE(20, 0)
          header.writeUInt32LE(1, 16)
          clipboard.writeBuffer(
            'CF_HDROP',
            Buffer.concat([header, Buffer.from(source + '\0\0', 'utf16le')]),
          )
        } else clipboard.writeBuffer('text/uri-list', Buffer.from(url))
      },
      { source, url: pathToFileURL(source).href },
    )
    await row('destination').click()
    await page.keyboard.press(`${mod}+v`)
    await expect.poll(() => existsSync(join(workspace, 'destination/report.pdf'))).toBe(true)
    await expect(explorer).toHaveAttribute('aria-busy', 'false')
    await page.keyboard.press(`${mod}+v`)
    await expect(page.getByText(/0 completed; 1 failed/)).toBeVisible()
    expect(await readFile(join(workspace, 'destination/report.pdf'))).toEqual(
      await readFile(source),
    )
  } finally {
    await shutdown(harness)
    await rm(external, { recursive: true, force: true })
  }
})

test('floating IDE panes share compact corners in both themes', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.classList.toggle('dark', value === 'dark')
      }, theme)
      for (const title of ['Files pane', 'Terminal pane', 'Artifacts pane']) {
        await page.getByRole('button', { name: new RegExp(`^${title}`) }).click()
        const pane = page.getByTestId('right-pane')
        await expect(pane).toBeVisible()
        await expect(pane).toHaveCSS('border-radius', '6px')
        await expect(pane).toHaveCSS('box-shadow', 'none')
        await expect(pane.getByRole('button', { name: 'Close pane', exact: true })).toBeVisible()
        await pane.getByRole('button', { name: 'Close pane', exact: true }).click()
      }
    }
  } finally {
    await shutdown(harness)
  }
})

/** 1×1 transparent PNG, as base64. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 1800×200 PNG — the aspect ratio is the point; see the wide-image test. */
const PNG_WIDE =
  'iVBORw0KGgoAAAANSUhEUgAABwgAAADIAQAAAADUp4gRAAAAyUlEQVR42u3PQREAAAwCIPuX1hJ77aAB6XcxNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ8N6z0InrHKhrFAAAAAElFTkSuQmCC'

test('dropped chat images open on click and copy on right-click @system-clipboard', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    // Drop the PNG onto the home composer's drop zone. A synthetic
    // DataTransfer is the only drivable way to attach in e2e (the native
    // picker is undriveable): a File built in JS has no real path, but
    // images travel inline as base64, so no path is ever needed.
    await page.evaluate((pngB64: string) => {
      const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File([bytes], 'dot.png', { type: 'image/png' }))
      const zone = document
        .querySelector<HTMLTextAreaElement>(
          'textarea[placeholder^="Describe a task or ask a question"]',
        )!
        .closest('div.relative')!
      zone.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }),
      )
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    }, PNG_1X1)

    // The attachment is an openable, copyable control (the accessible name
    // comes from the img's alt; the hover ring and the contract title are
    // CSS/tooltip-only).
    const thumbnail = page.getByRole('button', { name: 'Attached image', exact: true })
    await expect(thumbnail).toBeVisible()

    // Right-click copies the image to the system clipboard — read back in the
    // MAIN process, which is where `clipboard:writeImage` lands and which is
    // invisible to the renderer.
    await thumbnail.click({ button: 'right' })
    await expect
      .poll(() =>
        harness.app.evaluate(({ clipboard }) =>
          clipboard.readImage().isEmpty() ? 0 : clipboard.readImage().toPNG().length,
        ),
      )
      .toBeGreaterThan(0)

    // A pending image is still editable, so click opens the annotator rather
    // than the lightbox; Escape with nothing drawn closes it.
    await thumbnail.click()
    await expect(page.getByRole('dialog', { name: 'Annotate image' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Annotate image' })).toBeHidden()
  } finally {
    await shutdown(harness)
  }
})

test('annotating a pasted image replaces it by default, or keeps both @system-clipboard', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.evaluate((pngB64: string) => {
      const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File([bytes], 'wide.png', { type: 'image/png' }))
      document
        .querySelector<HTMLTextAreaElement>(
          'textarea[placeholder^="Describe a task or ask a question"]',
        )!
        .dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
        )
    }, PNG_WIDE)

    const chips = page.getByTestId('attachment-chips')
    const thumbnails = chips.getByRole('button', { name: 'Attached image', exact: true })
    await expect(thumbnails).toHaveCount(1)
    const originalSrc = await chips.locator('img').first().getAttribute('src')

    const editor = page.getByRole('dialog', { name: 'Annotate image' })
    const canvas = page.getByTestId('image-editor-canvas')
    /** Drag across the canvas between two fractions of its size. */
    const drag = async (from: [number, number], to: [number, number]): Promise<void> => {
      const box = (await canvas.boundingBox())!
      await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 })
      await page.mouse.up()
    }

    // Rectangle is the default tool; T switches to text, typed in place.
    await thumbnails.first().click()
    await expect(canvas).toBeVisible()
    await drag([0.1, 0.2], [0.4, 0.8])
    await page.keyboard.press('t')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3)
    await page.getByLabel('Annotation text').fill('bug here')
    await page.keyboard.press('Enter')
    await expect(editor.getByRole('button', { name: 'Undo' })).toBeEnabled()

    // Done with "Replace original" (the default) swaps the chip in place.
    await expect(editor.getByLabel('Replace original')).toBeChecked()
    await editor.getByRole('button', { name: 'Done' }).click()
    await expect(editor).toBeHidden()
    await expect(thumbnails).toHaveCount(1)
    const annotatedSrc = await chips.locator('img').first().getAttribute('src')
    expect(annotatedSrc).not.toBe(originalSrc)

    // The annotations are pixels in the image the model will receive.
    const redPixels = await page.evaluate(async (src: string) => {
      const img = new Image()
      img.src = src
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, c.width, c.height)
      let red = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 200 && data[i + 1]! < 100 && data[i + 2]! < 100) red++
      }
      return red
    }, annotatedSrc!)
    expect(redPixels).toBeGreaterThan(100)

    // Unchecked, the annotated copy is attached next to the original. The
    // checkbox keeps focus after the click; shortcuts must still work.
    await thumbnails.first().click()
    await editor.getByLabel('Replace original').uncheck()
    await page.keyboard.press('o')
    await expect(editor.getByRole('button', { name: 'Circle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await drag([0.5, 0.2], [0.7, 0.7])
    await editor.getByRole('button', { name: 'Done' }).click()
    await expect(thumbnails).toHaveCount(2)
    // The remove buttons only show on hover, hence `includeHidden`.
    await expect(
      chips.getByRole('button', { name: 'Remove wide.png', includeHidden: true }),
    ).toHaveCount(1)
    await expect(
      chips.getByRole('button', { name: 'Remove wide-annotated.png', includeHidden: true }),
    ).toHaveCount(1)

    // Paste and Replace read the system clipboard through main.
    await harness.app.evaluate(({ clipboard, nativeImage }, pngB64: string) => {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(pngB64, 'base64')))
    }, PNG_1X1)
    await thumbnails.first().click()
    await expect(canvas).toHaveAttribute('width', '1800')
    await editor.getByRole('button', { name: 'Paste image' }).click()
    // The pasted layer arrives selected, ready to move or delete.
    await expect(editor.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
    await editor.getByRole('button', { name: 'Replace image' }).click()
    await expect(canvas).toHaveAttribute('width', '1')
    await editor.getByRole('button', { name: 'Cancel' }).click()
    await editor.getByRole('button', { name: 'Discard' }).click()
    await expect(editor).toBeHidden()

    // Escape with unsaved marks asks first; a second Escape discards them.
    await thumbnails.first().click()
    await drag([0.2, 0.2], [0.3, 0.6])
    await page.keyboard.press('Escape')
    await expect(editor.getByText('Discard your annotations?')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
    await expect(thumbnails).toHaveCount(2)
  } finally {
    await shutdown(harness)
  }
})

test('a pasted wide image stays inside the transcript column', async () => {
  // Regression: chat images were capped in HEIGHT only (`max-h-40`). A wide
  // screenshot — a cropped strip of a window, 9:1 here — therefore rendered
  // 160px tall and ~1440px wide inside a 720px column. The user-message row is
  // a `justify-end` flex line, so the overflow grew LEFTWARDS: across the rows
  // beside it, over the activity group's left edge, and then clipped off by
  // the scroller, leaving most of the image unviewable.
  const harness = await launch({ env: { PHOSPHOR_E2E_IMAGE_HINTS: '1' } })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    // Paste, not drop: the drop path is covered above, and pasting a
    // screenshot is how this shape of image actually arrives.
    const composer = page.getByPlaceholder(/Describe a task…/i)
    await composer.click()
    await page.evaluate((pngB64: string) => {
      const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File([bytes], 'wide.png', { type: 'image/png' }))
      document
        .querySelector<HTMLTextAreaElement>('textarea[placeholder^="Describe a task…"]')!
        .dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
        )
    }, PNG_WIDE)
    await expect(page.getByRole('button', { name: 'Attached image', exact: true })).toHaveCount(1)

    await composer.fill('look at this')
    await composer.press('Enter')

    const scroller = page.getByTestId('transcript-scroll')
    const image = scroller.getByAltText('Attached image')
    await expect(image).toHaveCount(1)

    // The assertion is geometric on purpose: the class list is not the
    // contract, "it fits in the column" is.
    const shown = (await image.boundingBox())!
    const column = (await scroller.boundingBox())!
    expect(shown.width).toBeLessThanOrEqual(column.width)
    expect(shown.x).toBeGreaterThanOrEqual(column.x)
    expect(shown.x + shown.width).toBeLessThanOrEqual(column.x + column.width)
  } finally {
    await shutdown(harness)
  }
})

test('a pasted long URL wraps inside its bubble instead of scrolling the transcript', async () => {
  // Regression: the user bubble was capped at `max-w-[85%]` with no
  // `overflow-wrap`, so a pasted OAuth callback URL — one unbreakable word —
  // painted straight through the bubble and out of the column. Because the
  // scroller sets `overflow-y: auto`, its `overflow-x` resolved to `auto` too,
  // so the WHOLE transcript grew a horizontal scrollbar.
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    const longUrl =
      'http://localhost:1455/auth/callback?code=ac_N3IHRVZ2IfKBri7EOy5lRSAhogJGAP2P9cZBOMZbIJM.' +
      'ka21HmBM0ayf2Rxas1vZKI9Gi_BdssfrPm4eICNDDQ0&scope=openid+profile+email&state=' +
      'ZmFrZS1zdGF0ZS12YWx1ZS10aGF0LWlzLXZlcnktbG9uZy1pbmRlZWQtc28taXQtY2Fubm90LXdyYXA'
    const composer = page.getByPlaceholder(/Describe a task…/i)
    await composer.fill(`respond url: ${longUrl}`)
    await composer.press('Enter')

    const scroller = page.getByTestId('transcript-scroll')
    const bubble = page.getByTestId('user-message').last()
    await expect(bubble).toBeVisible()

    // Geometric, like the wide-image test: the class list is not the contract,
    // "it fits in the column" is.
    const shown = (await bubble.boundingBox())!
    const column = (await scroller.boundingBox())!
    expect(shown.x).toBeGreaterThanOrEqual(column.x)
    expect(shown.x + shown.width).toBeLessThanOrEqual(column.x + column.width)
    // Wrapped, not one clipped line.
    expect(shown.height).toBeGreaterThan(40)

    // The URL WRAPPED — it is not merely hidden by the scroller's clip, which
    // would leave the bubble itself overflowing and half the URL unreadable.
    const overflow = await page.evaluate(() => {
      const overflowOf = (el: HTMLElement): number => el.scrollWidth - el.clientWidth
      const bubbles = document.querySelectorAll<HTMLElement>('[data-testid="user-message"]')
      return {
        bubble: overflowOf(bubbles[bubbles.length - 1]!),
        scroller: overflowOf(
          document.querySelector<HTMLElement>('[data-testid="transcript-scroll"]')!,
        ),
      }
    })
    expect(overflow.bubble).toBeLessThanOrEqual(1)
    // And nothing anywhere in the transcript can be scrolled sideways.
    expect(overflow.scroller).toBeLessThanOrEqual(1)
  } finally {
    await shutdown(harness)
  }
})

test('a notice with an unbreakable path stays inside the window', async () => {
  // Regression: the card sat in a grid whose implicit `auto` column sized to
  // the card's min-content, so one long path (or a nowrap lane title) widened
  // it past the 22rem stack and off the window's right edge, taking the
  // dismiss button with it.
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('longnotify')
    await page.getByRole('button', { name: /Start session/i }).click()

    const card = page.getByTestId('toast').filter({ hasText: 'ENOENT' }).locator('.toast-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    // Geometric: the card ends inside the stack, and the stack inside the
    // window. Polled because the slide-in starts 24px to the right on purpose.
    const rightEdge = async (el: typeof card): Promise<number> => {
      const b = (await el.boundingBox())!
      return b.x + b.width
    }
    const stackRight = await rightEdge(page.getByTestId('toast-stack'))
    await expect.poll(() => rightEdge(card)).toBeLessThanOrEqual(stackRight)
    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth)
    expect(stackRight).toBeLessThanOrEqual(viewportWidth)

    const box = (await card.boundingBox())!
    // Wrapped onto several lines, not clipped on one.
    expect(box.height).toBeGreaterThan(60)
    await expect(
      page.getByTestId('toast').filter({ hasText: 'ENOENT' }).getByRole('button', {
        name: 'Dismiss',
      }),
    ).toBeInViewport({ ratio: 1 })
  } finally {
    await shutdown(harness)
  }
})

test('right-hand pane controls stay clear of the OS window controls', async () => {
  // Regression: the pane header used to render its own expand/close buttons at
  // the top-right of the window, directly underneath the Window Controls
  // Overlay that Electron paints there on Windows/Linux — so "close pane" sat
  // on top of "close app". Only the chat header carried the inset padding, and
  // it stops spanning the window as soon as a pane opens.
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: /Terminal pane/ }).click()
    const closePane = page.getByRole('button', { name: 'Close pane' })
    await expect(closePane).toBeVisible({ timeout: 10_000 })

    // The pane's own chrome must start below the title bar, which is the one
    // element allowed to occupy the strip the OS draws its buttons in.
    const titleBarBottom = await page
      .locator('header.titlebar-drag')
      .first()
      .evaluate((el) => el.getBoundingClientRect().bottom)
    const paneButton = await closePane.evaluate((el) => el.getBoundingClientRect().top)
    expect(paneButton).toBeGreaterThanOrEqual(titleBarBottom)

    // The composer's attach button must survive layout work — it sits in the
    // same footer the pane squeezes.
    await expect(page.getByLabel('Attach files')).toBeVisible()

    // Fullscreen (↗) overlays the main region instead of squishing the chat.
    // It used to resize the split to 85/15, which crushed the transcript to an
    // unusable 15% column, hardcoded 45% back on restore, and persisted the
    // squish for every session in the workspace.
    const chatWidth = (): Promise<number> =>
      page.getByTestId('transcript-scroll').evaluate((el) => el.getBoundingClientRect().width)
    const widthBefore = await chatWidth()
    await page.getByRole('button', { name: 'Fullscreen pane' }).click()
    const mainWidth = await page.locator('main').evaluate((el) => el.getBoundingClientRect().width)
    const paneWidth = await page
      .getByTestId('right-pane')
      .evaluate((el) => el.getBoundingClientRect().width)
    expect(paneWidth).toBeGreaterThan(mainWidth * 0.95)
    // Exiting restores the exact split — the saved size is never mutated by
    // fullscreen (the old resize path clobbered it to 45).
    await page.getByRole('button', { name: 'Exit fullscreen' }).click()
    expect(Math.abs((await chatWidth()) - widthBefore)).toBeLessThan(2)

    // The pane swaps to the left of the chat (and back) on request.
    await page.getByRole('button', { name: 'Move pane to the left' }).click()
    const paneLeft = await page
      .getByTestId('right-pane')
      .evaluate((el) => el.getBoundingClientRect().left)
    const chatLeft = await page
      .getByTestId('transcript-scroll')
      .evaluate((el) => el.getBoundingClientRect().left)
    expect(paneLeft).toBeLessThan(chatLeft)
    await page.getByRole('button', { name: 'Move pane to the right' }).click()
  } finally {
    await shutdown(harness)
  }
})

test('settings modal switches theme and reports versions', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.getByRole('button', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    await page.getByRole('button', { name: 'About', exact: true }).click()
    // The heading is the brand lockup (mark + wordmark), so its accessible
    // name is just "Phosphor" — the mark itself is decorative.
    const aboutHeading = page.getByRole('heading', { name: 'Phosphor', exact: true })
    await expect(aboutHeading).toBeVisible()
    await expect(page.locator('.phosphor-mark')).toBeVisible()
    await expect(page.getByText('Phosphor version')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(aboutHeading).toBeHidden()
  } finally {
    await shutdown(harness)
  }
})

test('settings search lists matches and jumps to the chosen one', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    await page.getByRole('button', { name: 'Settings' }).click()
    const field = page.getByRole('combobox', { name: 'Search settings' })
    await expect(field).toBeFocused({ timeout: 10_000 })

    await field.fill('retry')
    const results = page.getByRole('listbox', { name: 'Settings search results' })
    await expect(results.getByRole('option')).toHaveCount(4)
    await expect(results.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')

    await field.press('ArrowDown')
    await field.press('ArrowDown')
    await field.press('Enter')
    await expect(results).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Agent defaults' })).toBeVisible()
    await expect(page.getByText('Max retries')).toBeInViewport()

    // Escape clears the search before it closes settings.
    await page.keyboard.press('Escape')
    await expect(field).toHaveValue('')
    await expect(field).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(field).toBeHidden()
  } finally {
    await shutdown(harness)
  }
})

test('the optimization tab reports headroom state without starting anything', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Optimization', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Optimization', exact: true })).toBeVisible({
      timeout: 10_000,
    })

    // Both new channels answered through the real main process: the manager
    // card resolved past "Checking Headroom…" (headroom:status) and the
    // savings tiles past "Reading session files…" (optimization:stats).
    const compression = page.getByRole('switch', { name: 'Compress tool results', exact: true })
    await expect(compression).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Lanes with savings')).toBeVisible({ timeout: 10_000 })

    // Compression ships off — the Advisor says so, and the switch agrees.
    await expect(page.getByText('Tool-result compression is off')).toBeVisible()
    await expect(compression).toHaveAttribute('aria-checked', 'false')
    // Text compression stays inert until a retrieve tool exists, and a switch
    // that cannot move must refuse the click rather than look live.
    await expect(
      page.getByRole('switch', { name: 'Compress search & log output', exact: true }),
    ).toBeDisabled()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Optimization', exact: true })).toBeHidden()
  } finally {
    await shutdown(harness)
  }
})

test('command palette opens with the keyboard shortcut', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    const palette = page.getByPlaceholder('Type a command…')
    await expect(palette).toBeVisible({ timeout: 10_000 })

    // Right-pane commands are session-scoped: the pane is rendered by
    // MainWithPanes, which requires an active session, so offering them on the
    // home screen was a no-op that also desynced the pane state.
    await palette.fill('terminal')
    await expect(page.getByText('Toggle terminal')).toBeHidden()

    // A command that is always available still resolves, so this is testing
    // the filter and not just an empty palette.
    await palette.fill('sidebar')
    await expect(page.getByText('Toggle sidebar')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
  } finally {
    await shutdown(harness)
  }
})

for (const bracketedPaste of [true, false]) {
  test(`chat commands run only after Enter (bracketed paste ${bracketedPaste})`, async () => {
    const workspace = await scratchDir('phosphor-e2e-command-')
    const inputrc = join(workspace, '.inputrc')
    await writeFile(inputrc, `set enable-bracketed-paste ${bracketedPaste ? 'on' : 'off'}\n`)
    const h = await launch({
      workspace,
      env: {
        SHELL: bracketedPaste && process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
        INPUTRC: inputrc,
      },
    })
    const { page } = h
    try {
      await openWorkspace(page)
      await page.getByPlaceholder('Describe a task or ask a question').fill('terminal-command')
      await page.getByRole('button', { name: /Start session/i }).click()
      const paste = page.getByRole('button', { name: "Run in terminal (pastes, doesn't execute)" })
      const staged = page.getByRole('textbox', { name: 'Staged terminal command' })
      const result = join(h.workspace, 'command-ran.txt')
      const toggle = process.platform === 'darwin' ? 'Meta+`' : 'Control+`'

      // Cold spawn, already-open pane, and a reattached shell. Old Readline
      // must stage multiline commands instead of running the first line early.
      for (let i = 0; i < 3; i++) {
        if (i === 2) {
          await page.keyboard.press(toggle)
          await expect(page.locator('.xterm')).toHaveCount(0)
        }
        await paste.click()
        await expect(page.locator('.xterm')).toHaveCount(1)
        if (bracketedPaste) {
          await expect(page.locator('.xterm-rows')).toContainText('printf two')
          await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
        } else {
          await expect(staged).toHaveValue(
            'printf one >> command-ran.txt\nprintf two >> command-ran.txt',
          )
          await expect(staged).toBeFocused()
          if (i === 0) {
            await page.getByRole('button', { name: 'Cancel', exact: true }).click()
            await expect(staged).toHaveCount(0)
            expect(await readFile(result, 'utf8').catch(() => '')).toBe('')
            await paste.click()
            await expect(staged).toBeFocused()
          }
        }
        expect(await readFile(result, 'utf8').catch(() => '')).toBe('onetwo'.repeat(i))
        await page.keyboard.press('Enter')
        await expect
          .poll(() => readFile(result, 'utf8').catch(() => ''))
          .toBe('onetwo'.repeat(i + 1))
      }
    } finally {
      await shutdown(h)
    }
  })
}

test('terminal pane spawns a real shell, and reopening replays its scrollback @system-clipboard', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    // Start a session so the pane toggles are available.
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    const toggleTerminal = async (): Promise<void> => {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+`' : 'Control+`')
    }

    await toggleTerminal()
    await expect(page.getByText('Terminal', { exact: true })).toBeVisible({ timeout: 15_000 })
    // xterm renders into a canvas/rows container once the PTY is attached.
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    // A spawn failure leaves the pane on this forever, which is exactly the
    // regression: assert we got past it rather than just that chrome rendered.
    await expect(page.getByText('Starting shell…')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByText('Could not start a shell')).toBeHidden()

    // Prove the shell is real and talking back.
    const marker = 'phosphor_marker_7f3a'
    await page.locator('.xterm').first().click()
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 15_000 })

    // Copying is entirely ours: xterm ships no copy binding and its selection
    // is invisible to the browser, so nothing else can put it on the clipboard.
    await page.locator('.xterm').first().click({ button: 'right' })
    // Named by its shortcut so this cannot match the chat's own Copy buttons.
    await expect(page.getByRole('button', { name: /^Copy\s+(Ctrl\+Shift\+C|⌘C)$/ })).toBeVisible()
    await page.getByRole('button', { name: 'Select all' }).click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+Shift+C')
    await expect
      .poll(() => harness.app.evaluate(({ clipboard }) => clipboard.readText()), {
        timeout: 10_000,
      })
      .toContain(marker)

    // A clipboard shortcut must cancel the browser's native paste. Returning
    // false from xterm's custom key handler alone only stops its key handling.
    // Check the real shell's input too, not just text echoed into the viewport.
    const pasted = 'phosphor_paste_8c2b'
    await harness.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasted)
    await page.evaluate(() => {
      document.querySelector('.xterm')!.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).code === 'KeyV') {
          document
            .querySelector('.xterm')!
            .setAttribute('data-paste-prevented', String(event.defaultPrevented))
        }
      })
    })
    await page.keyboard.type("printf '%s' '")
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+Shift+V')
    await expect(page.locator('.xterm-rows')).toContainText(pasted)
    await page.keyboard.type("' > pasted.txt")
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readFile(join(harness.workspace, 'pasted.txt'), 'utf8').catch(() => null))
      .toBe(pasted)
    await expect(page.locator('.xterm')).toHaveAttribute('data-paste-prevented', 'true')

    // Context-menu paste has no keyboard default to cancel and still works once.
    const menuPasted = 'phosphor_menu_paste_9d3c'
    await harness.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), menuPasted)
    await page.keyboard.type("printf '%s' '")
    await page.locator('.xterm').first().click({ button: 'right' })
    await page.getByRole('button', { name: /^Paste\s+(Ctrl\+Shift\+V|⌘V)$/ }).click()
    await expect(page.locator('.xterm-rows')).toContainText(menuPasted)
    await page.keyboard.type("' > menu-pasted.txt")
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readFile(join(harness.workspace, 'menu-pasted.txt'), 'utf8').catch(() => null))
      .toBe(menuPasted)

    // Closing the pane disposes the xterm but keeps the PTY; reopening must
    // replay main's scrollback instead of showing a blank pane in front of a
    // live shell.
    await toggleTerminal()
    await expect(page.locator('.xterm')).toHaveCount(0)
    await toggleTerminal()
    await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 15_000 })
  } finally {
    await shutdown(harness)
  }
})

test('terminal web and OSC 8 links open externally with Control or Command click', async () => {
  const h = await launch()
  const { page } = h
  try {
    // Observe the real main-process boundary without launching the user's browser.
    await h.app.evaluate(({ shell }) => {
      const state = globalThis as unknown as { openedUrls: string[] }
      state.openedUrls = []
      shell.openExternal = async (url) => {
        state.openedUrls.push(url)
      }
    })
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+`' : 'Control+`')
    const terminal = page.locator('.xterm').first()
    await expect(terminal).toBeVisible()
    await terminal.click()
    const url = 'http://localhost:3000/test?q=1'
    const oscUrl = 'https://example.com/terminal?from=osc8'
    await page.keyboard.type(
      `printf '\\033[2J\\033[H${url}\\n\\033]8;;${oscUrl}\\007Open browser\\033]8;;\\007\\n\\033]8;;file:///tmp/blocked\\007Blocked link\\033]8;;\\007\\n'`,
    )
    await page.keyboard.press('Enter')
    const rows = page.locator('.xterm-rows > div')
    const detected = rows.filter({ hasText: /^http:\/\/localhost:3000\/test/ })
    const osc = rows.filter({ hasText: /^Open\s+browser/ })
    await expect(osc).toBeVisible()
    const opened = (): Promise<string[]> =>
      h.app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls)
    const expected: string[] = []
    for (const row of [detected, osc]) {
      for (const modifiers of [[], ['Control'], ['Meta']] as ('Control' | 'Meta')[][]) {
        // Rows are pointer-events:none; the xterm screen handles the real mouse
        // events at these cell coordinates instead of the text div itself.
        await row.hover({ position: { x: 20, y: 8 }, force: true })
        await expect(terminal.locator('.xterm-screen')).toHaveClass(/xterm-cursor-pointer/)
        await row.click({ position: { x: 20, y: 8 }, modifiers, force: true })
        expected.push(row === detected ? url : oscUrl)
        await expect.poll(opened).toEqual(expected)
        await expect(page.getByRole('button', { name: 'Select all' })).toBeHidden()
      }
    }
    // Ordinary right-click still offers the clipboard menu, never navigation.
    await osc.click({ position: { x: 20, y: 8 }, button: 'right', force: true })
    await expect(page.getByRole('button', { name: 'Select all' })).toBeVisible()
    await page.keyboard.press('Escape')
    await rows
      .filter({ hasText: /^Blocked\s+link/ })
      .click({ position: { x: 20, y: 8 }, force: true })
    expect(await opened()).toEqual(expected)
    expect(h.app.windows()).toHaveLength(1)
  } finally {
    await shutdown(h)
  }
})

test('the right pane is per session, so a terminal does not follow you', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    // Two sessions in the same workspace.
    await page.getByPlaceholder('Describe a task or ask a question').fill('first')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: /^New$/ }).click()
    await page.getByPlaceholder('Describe a task or ask a question').fill('second')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    // Open a terminal in the SECOND session.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+`' : 'Control+`')
    await expect(page.getByText('Terminal', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })

    // Switching to the first session must NOT bring the pane along. It used to:
    // rightPane was global, so the pane opened everywhere and — because first
    // open auto-spawns — silently forked a login shell in every session you
    // visited.
    // The stub names every session "stub session", so rows are identified by
    // order (sidebar is newest-first) and the switch is confirmed by the user
    // bubble — otherwise a hidden Terminal could just mean the click missed.
    const rows = page.getByTestId('session-row')
    await expect(rows).toHaveCount(2, { timeout: 20_000 })
    const terminalTitle = page.getByText('Terminal', { exact: true })

    await rows.nth(1).click()
    await expect(page.getByText('first', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(terminalTitle).toBeHidden({ timeout: 10_000 })

    // …and coming back restores it, with its shell intact.
    await rows.nth(0).click()
    await expect(page.getByText('second', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(terminalTitle).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10_000 })
  } finally {
    await shutdown(harness)
  }
})

test('tool run: grouping, in-flight animation, and clean streaming', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()

    // The in-flight window is short, so watch for it with a MutationObserver
    // rather than polling — a poll can straddle the whole window and miss it.
    // Also capture whether a LIVE activity group was expanded at the time,
    // which is the live-vs-settled behavior (open while working).
    await page.evaluate(() => {
      const w = window as unknown as {
        __sawRunning?: boolean
        __sawWorkingIndicator?: boolean
        __liveOpen?: string
      }
      const workingIndicator = () =>
        /\d[\d.]*(ms|s)\s*·\s*[\d.]+[kM]?\s*tokens/.test(document.body.innerText) &&
        document.querySelector('[data-testid="working-indicator"] .phosphor-loader') !== null
      w.__sawRunning = document.querySelector('.tool-running-dot') !== null
      w.__sawWorkingIndicator = workingIndicator()
      new MutationObserver(() => {
        if (document.querySelector('.tool-running-dot')) w.__sawRunning = true
        if (workingIndicator()) w.__sawWorkingIndicator = true
        const live = document.querySelector('[data-testid="activity-group"][data-live="true"]')
        if (live && w.__liveOpen === undefined) {
          w.__liveOpen =
            live.querySelector('[data-testid="activity-summary"]')?.getAttribute('aria-expanded') ??
            'missing'
        }
      }).observe(document.body, { childList: true, subtree: true, attributes: true })
    })

    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    // The running affordance appeared while tools were executing…
    expect(
      await page.evaluate(() => (window as unknown as { __sawRunning: boolean }).__sawRunning),
    ).toBe(true)
    // …and is gone now that the run finished.
    await expect(page.locator('.tool-running-dot')).toHaveCount(0)

    // The persistent working strip (elapsed time · tokens, Claude-Code-style)
    // appeared above the composer during the run and disappears once done.
    expect(
      await page.evaluate(
        () => (window as unknown as { __sawWorkingIndicator: boolean }).__sawWorkingIndicator,
      ),
    ).toBe(true)
    await expect(page.getByText(/tokens$/)).toBeHidden()

    // Live vs settled: the group was expanded while work was in flight…
    expect(
      await page.evaluate(() => (window as unknown as { __liveOpen?: string }).__liveOpen),
    ).toBe('true')

    // Settled runs collapse to a verb-counted summary. Counting (rather than
    // listing every call) is what keeps an 18-deep run to one line.
    const summary = page.getByTestId('activity-summary').first()
    await expect(summary).toBeVisible()
    // …and auto-collapsed once it settled.
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(summary).toContainText(/step/)
    await expect(summary).toContainText(/edited 1 file/)
    await expect(summary).toContainText(/ran 1 command/)

    // The whole run is ONE group even though pi sent one message per tool
    // call — this is the regression that made runs march down the page.
    await expect(page.getByTestId('activity-group')).toHaveCount(1)

    // Expanding shows the individual calls as rows.
    await summary.click()
    const group = page.getByTestId('activity-group')
    await expect(group.getByRole('button', { name: /Edited\s+hello\.ts/ })).toBeVisible()
    await expect(group.getByRole('button', { name: /Ran/ })).toBeVisible()

    // Placeholder tool names never surface (pi ≥0.84 omits the name until
    // toolcall_end).
    await expect(page.getByText(/unknown/)).toHaveCount(0)

    // Per-message cost is gone from the transcript.
    await expect(page.locator('text=/\\$\\d+\\.\\d{4}/')).toHaveCount(0)

    // Streaming repair: the transcript briefly contained "**hello.ts" before
    // its closing marker arrived. Raw asterisks must never survive to the DOM.
    const transcript = await page.locator('.md-content').allInnerTexts()
    expect(transcript.join('\n')).not.toContain('**')

    // Spacing: ONE step (`STREAM_GAP`, 8px), owned by the row wrapper and
    // nothing else. Every row either leads with that step or, being the
    // first, leads with nothing — a row carrying some third value means a
    // second owner of vertical space came back.
    const gaps = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-index]')] as HTMLElement[]
      return nodes.slice(0, 4).map((n) => {
        const inner = n.firstElementChild as HTMLElement | null
        return inner ? parseFloat(getComputedStyle(inner).paddingTop) : 0
      })
    })
    expect(gaps.some((gap) => gap === 8)).toBe(true)
    expect(gaps.filter((gap) => gap !== 0 && gap !== 8)).toEqual([])

    // Extension status line arrived styled with ANSI SGR codes; the strip
    // must show clean (optionally colored) text, never raw escape bytes.
    const statusText = await page.getByText(/MCP: 2 servers enabled/).innerText()
    expect(statusText).not.toContain('[38;2')
    expect(statusText).not.toContain('\u001b')
  } finally {
    await shutdown(harness)
  }
})

test('worktree flow: create from the branch chip, session stays under the project group', async () => {
  // The workspace must be a git repo BEFORE the app queries git:info.
  const workspace = await scratchDir('phosphor-e2e-wt-')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  await writeFile(join(workspace, 'hello.ts'), 'export function hello() {\n  return "new"\n}\n')
  await run('git', ['init', '-b', 'main'], { cwd: workspace })
  await run('git', ['config', 'user.email', 'e2e@phosphor.dev'], { cwd: workspace })
  await run('git', ['config', 'user.name', 'Phosphor e2e'], { cwd: workspace })
  await run('git', ['add', '-A'], { cwd: workspace })
  await run('git', ['commit', '-m', 'initial'], { cwd: workspace })

  const harness = await launch({ workspace })
  const { page } = harness
  try {
    await openWorkspace(page)

    // Create a worktree from the top bar's branch control.
    await page.getByTestId('branch-chip').click()
    await page.getByRole('button', { name: 'New branch…' }).click()
    await page.getByPlaceholder('new branch name').fill('task-1')
    await page.getByRole('button', { name: 'Create worktree' }).click()

    // Chip now targets the worktree.
    await expect(page.getByTestId('branch-chip')).toContainText('task-1', { timeout: 10_000 })

    // Start a session from the home composer. It does NOT continue on task-1:
    // a new chat gets its own branch off trunk, so this lands in a second
    // worktree.
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    // The folder is slugged from the FIRST MESSAGE, not from the generated
    // title, because the branch is now cut before the naming model is asked —
    // that inversion is what keeps the send button from blocking on a ~13s
    // subprocess. The folder never changes afterwards: it is a live session's
    // cwd, and moving it would break the session's binding to its transcript.
    expect(existsSync(join(workspace, '.phosphor', 'worktrees', 'update-hello-ts'))).toBe(true)

    // ...and then the name lands and the BRANCH is renamed to match it, so the
    // branch chip and the session title still agree. "Stub Session Title" is
    // the stub's deterministic answer to the naming prompt.
    await expect(page.getByTestId('branch-chip')).toContainText('phosphor/stub-session-title', {
      timeout: 30_000,
    })
    // The generated name reaches both surfaces. Two locators, not one
    // `getByText`: the stub now persists a rename as `session_info` (as pi
    // does), so the sidebar row reads the name off disk as well and a bare
    // text match is ambiguous.
    await expect(page.getByRole('banner').getByText('Stub Session Title')).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId('session-row').first()).toContainText('Stub Session Title', {
      timeout: 15_000,
    })

    const branches = await run('git', ['branch', '--format=%(refname:short)'], { cwd: workspace })
    const names = branches.stdout.split('\n').map((b) => b.trim())
    expect(names).toContain('phosphor/stub-session-title')
    // Renamed, not duplicated: the provisional slug branch is gone.
    expect(names).not.toContain('phosphor/update-hello-ts')

    // The "still being named" treatment must CLEAR. Catching the shimmer while
    // it is up would be racing a sub-second window, but a stuck one is the
    // failure that actually matters: `.name-pending` paints its glyphs with a
    // transparent fill over a moving gradient, so a flag that never resets
    // leaves every session title permanently animated.
    await expect(page.locator('.name-pending')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId('branch-chip')).not.toHaveAttribute('data-tooltip', /provisional/)

    // Still one sidebar group for the project (not a header per branch); the
    // worktree is surfaced on the session row itself instead.
    await expect(page.getByTestId('workspace-group')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('[data-tooltip="Runs in a git worktree"]')).toBeVisible({
      timeout: 15_000,
    })

    // The top bar's branch control marks the worktree.
    await expect(page.locator('[data-tooltip*="Worktree of"]')).toBeVisible({ timeout: 10_000 })

    // ...and the folder chip beside it still names the PROJECT. The reported
    // bug: with a worktree session open it showed the worktree folder's own
    // basename — the branch slug — so the top bar read as if the user had
    // switched to a workspace called "update-hello-ts".
    const folderChip = page.getByRole('banner').getByTestId('workspace-chip')
    await expect(folderChip).toContainText(basename(workspace), { timeout: 10_000 })
    await expect(folderChip).not.toContainText('update-hello-ts')
    await expect(folderChip).not.toContainText('stub-session-title')
  } finally {
    await shutdown(harness)
  }
})

test('a session whose file lands late still becomes a real, right-clickable row', async () => {
  // The reported bug: right-click did nothing on a chat you had just started,
  // and kept doing nothing until you clicked away to another session and back.
  //
  // The cause was never the menu. A live session with no row in `disk` yet
  // renders as `PendingSessionRow`, which deliberately has no context menu at
  // all (every SessionRow action is keyed on `meta.path`, which it lacks). It
  // should be a flicker — except the directory watcher that promotes it was
  // attached to a session directory that did not exist yet, and chokidar never
  // revisits a missing target. So the promotion never came.
  //
  // The delay is what makes this a real test: with the stub writing its
  // session file synchronously the directory is always there before Phosphor can
  // attach, and this passes against the unfixed code too (confirmed).
  const workspace = await scratchDir('phosphor-e2e-late-')
  await writeFile(join(workspace, 'hello.ts'), 'export function hello() {\n  return "new"\n}\n')

  const harness = await launch({
    workspace,
    env: { PHOSPHOR_E2E_SESSION_WRITE_DELAY_MS: '2500' },
  })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()

    const row = page.getByTestId('session-row').first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    // Promoted out of the placeholder WITHOUT switching session and back.
    await expect(row).not.toHaveAttribute('data-pending', 'true', { timeout: 30_000 })

    await row.click({ button: 'right' })
    // Any SessionRow-only action proves the promotion. `PendingSessionRow`
    // has a context menu too, but only the three actions that route through
    // the live process (Open / Rename / Export) — Fork is keyed on the
    // session file, so it can only come from a promoted row. (Rename is not
    // in this menu — it is an inline edit on the row, covered by the next
    // test.)
    await expect(
      page.getByTestId('context-menu').getByRole('button', { name: /^Fork/ }),
    ).toBeVisible({ timeout: 10_000 })
  } finally {
    await shutdown(harness)
  }
})

test('double-clicking a sidebar row renames the session inline', async () => {
  // Rename used to be a modal behind two popovers. It is now an inline input
  // on the row itself, which only works if three things hold: the field takes
  // focus and real keystrokes, the commit reaches pi, and the sidebar re-reads
  // the name afterwards — the row's title comes from the session file on disk,
  // not from renderer state, so a rename that never persists appears to revert
  // (verified: dropping the stub's `session_info` write fails this test).
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()

    // Let auto-naming finish first: it lands seconds after the first reply and
    // would otherwise overwrite the rename mid-test.
    const row = page.getByTestId('session-row').first()
    await expect(row).toContainText('Stub Session Title', { timeout: 30_000 })
    await expect(page.locator('.name-pending')).toHaveCount(0, { timeout: 15_000 })

    await row.dblclick()
    const input = page.getByLabel('Session name')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await expect(input).toBeFocused()

    // Pre-filled with the current name and pre-selected, so typing replaces it.
    await expect(input).toHaveValue('Stub Session Title')
    // Real mouse click + real keystrokes, not `fill()`: `fill()` focuses the
    // element itself and would pass even if the row swallowed the click.
    await input.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Renamed inline')
    await expect(input).toHaveValue('Renamed inline')
    await page.keyboard.press('Enter')

    // Committed through pi and read back from the session file, not just held
    // in renderer state: the stub records the rename as `session_info`, which
    // is what the sidebar scanner reads.
    await expect(row).toContainText('Renamed inline', { timeout: 15_000 })
    await expect(page.getByLabel('Session name')).toHaveCount(0)

    // Escape abandons a second edit.
    await row.dblclick()
    await page.getByLabel('Session name').fill('Not this one')
    await page.getByLabel('Session name').press('Escape')
    await expect(row).toContainText('Renamed inline', { timeout: 10_000 })
  } finally {
    await shutdown(harness)
  }
})

test('new chat without isolation runs in the open workspace', async () => {
  const workspace = await scratchDir('phosphor-e2e-nowt-')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  await writeFile(join(workspace, 'hello.ts'), 'export function hello() {\n  return "new"\n}\n')
  await run('git', ['init', '-b', 'main'], { cwd: workspace })
  await run('git', ['config', 'user.email', 'e2e@phosphor.dev'], { cwd: workspace })
  await run('git', ['config', 'user.name', 'Phosphor e2e'], { cwd: workspace })
  await run('git', ['add', '-A'], { cwd: workspace })
  await run('git', ['commit', '-m', 'initial'], { cwd: workspace })

  const harness = await launch({ workspace })
  const { page } = harness
  try {
    await openWorkspace(page)

    // Untick the composer's "new branch" box: the chat should then run on the
    // branch that is already checked out, creating nothing.
    await page.getByRole('checkbox', { name: 'new branch' }).uncheck()
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })

    await expect(page.getByTestId('branch-chip')).toContainText('main', { timeout: 15_000 })
    const branches = await run('git', ['branch', '--format=%(refname:short)'], { cwd: workspace })
    expect(branches.stdout.trim()).toBe('main')
    expect(existsSync(join(workspace, '.phosphor'))).toBe(false)
  } finally {
    await shutdown(harness)
  }
})

test('Connectors: resolved rows, enabled toggle, add custom server', async () => {
  // Seed a global server in an agent dir of this test's own. Shared would leak:
  // this `mcp.json` is never cleaned up, and every later test would inherit a
  // global MCP server it did not ask for.
  const soloAgentDir = privateAgentDir()
  await writeFile(
    join(soloAgentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } }),
  )
  // Dedicated prefs dir: project-scope writes target the ACTIVE workspace, so
  // a `lastSessionPath` left by an earlier test could restore a different
  // workspace and send the write there.
  const harness = await launch({
    agentDir: soloAgentDir,
    userDataDir: await scratchDir('phosphor-e2e-mcp-'),
  })
  const { page, workspace } = harness
  try {
    await openWorkspace(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'MCP Connectors', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'MCP Connectors' })).toBeVisible({
      timeout: 10_000,
    })

    // The seeded global server resolves into the list, and `pi mcp list`
    // reports its state. It is in the "Connected" section, which renders
    // BEFORE the catalog — so the first checkbox in the dialog is its own
    // enabled toggle. Scoped to the dialog: the home composer behind it has
    // checkboxes of its own.
    const linear = page.getByTestId('connector-linear')
    await expect(linear.getByText('https://mcp.linear.app/mcp')).toBeVisible()
    await expect(linear.getByText('Needs sign-in')).toBeVisible({ timeout: 20_000 })
    await expect(linear.getByText('exposure: codemode')).toBeVisible()

    // Turning it off writes pi's `"enabled": false`. Plain click: the checkbox
    // is controlled and only re-renders after the IPC round trip, which
    // uncheck()'s immediate post-click assertion would race.
    await page.getByRole('dialog').getByRole('checkbox').first().click()
    await expect
      .poll(async () => {
        const raw = await readFile(join(soloAgentDir, 'mcp.json'), 'utf8')
        return (JSON.parse(raw).mcpServers.linear as { enabled?: boolean }).enabled
      })
      .toBe(false)
    await expect(linear.getByText('Disabled')).toBeVisible()

    // Add a project-scoped stdio server → workspace/.pi/mcp.json is written.
    await page.getByRole('button', { name: 'Add custom server…' }).click()
    await page.getByPlaceholder('server name (e.g. linear)').fill('local-tools')
    await page.getByRole('radio', { name: 'Local command' }).check()
    await page.getByPlaceholder('npx some-mcp-server --flag').fill('npx local-tools-mcp')
    await page.getByRole('radio', { name: /This project/ }).check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect
      .poll(async () => {
        try {
          const raw = await readFile(join(workspace, '.pi', 'mcp.json'), 'utf8')
          return JSON.parse(raw).mcpServers['local-tools'] as Record<string, unknown>
        } catch {
          return null
        }
      })
      .toEqual({ command: 'npx', args: ['local-tools-mcp'] })
  } finally {
    await shutdown(harness)
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('Connectors: adding a catalog connector writes pi config and starts sign-in', async () => {
  // Own agent dir: this writes a global mcp.json, which nothing cleans up.
  const soloAgentDir = privateAgentDir()
  const harness = await launch({
    agentDir: soloAgentDir,
    userDataDir: await scratchDir('phosphor-e2e-connectors-'),
  })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'MCP Connectors', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'MCP Connectors' })).toBeVisible({
      timeout: 10_000,
    })

    // Datadog is the interesting row: its endpoint is per site, so the choice
    // has to reach the written config rather than defaulting silently. pi
    // signs in to an HTTP server with OAuth on its own, so the URL is all.
    const datadog = page.getByTestId('connector-datadog')
    await datadog.getByRole('combobox').selectOption('eu1')
    await datadog.getByRole('button', { name: 'Add', exact: true }).click()

    const readServer = async (name: string): Promise<unknown> => {
      try {
        const raw = await readFile(join(soloAgentDir, 'mcp.json'), 'utf8')
        return JSON.parse(raw).mcpServers[name] ?? null
      } catch {
        return null
      }
    }
    await expect
      .poll(() => readServer('datadog'))
      .toEqual({ url: 'https://mcp.datadoghq.eu/v1/mcp' })

    // Slack is the other interesting row: it has no dynamic registration, so
    // a client id alone must produce a public-client config on the loopback
    // callback Slack's app was registered with.
    const slack = page.getByTestId('connector-slack')
    await slack.getByPlaceholder('client ID').fill('4242.1337')
    await slack.getByRole('button', { name: 'Add', exact: true }).click()

    await expect
      .poll(() => readServer('slack'))
      .toEqual({
        url: 'https://mcp.slack.com/mcp',
        oauth: {
          clientId: '4242.1337',
          callbackUrl: 'http://localhost:19876/callback',
          scope: expect.stringContaining('search:read.public'),
        },
      })

    // Add is not a config edit, it is "connect this" — so it starts
    // `pi mcp login` itself. Writing mcp.json and then waiting for a separate
    // Sign in click read as "Add did nothing".
    await expect(slack.getByText(/Approve access in your browser/)).toBeVisible({
      timeout: 30_000,
    })
    await expect(slack.getByText('https://stub.test/oauth/authorize?server=slack')).toBeVisible()
  } finally {
    await shutdown(harness)
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('Connectors: signing in works with no session open', async () => {
  // Seeded rather than added through the UI: this test is about the headless
  // sign-in path, and the previous test already covers writing config.
  const soloAgentDir = privateAgentDir()
  await writeFile(
    join(soloAgentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } }),
  )
  const harness = await launch({
    agentDir: soloAgentDir,
    userDataDir: await scratchDir('phosphor-e2e-signin-'),
  })
  const { page } = harness
  try {
    await openWorkspace(page)
    // Deliberately no session: the whole point is that Settings works on a
    // fresh launch, which is when someone goes looking for connectors.
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'MCP Connectors', exact: true }).click()

    const linear = page.getByTestId('connector-linear')
    await expect(linear.getByText('Needs sign-in')).toBeVisible({ timeout: 20_000 })
    await linear.getByRole('button', { name: 'Sign in' }).click()

    // Main ran `pi mcp login linear` and surfaced the URL pi printed — with
    // no session in the sidebar.
    await expect(linear.getByText(/Approve access in your browser/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(linear.getByText('https://stub.test/oauth/authorize?server=linear')).toBeVisible()

    await linear.getByRole('button', { name: 'Cancel' }).click()
    await expect(linear.getByText(/Approve access in your browser/)).toHaveCount(0)

    // Again, and this time the browser approves: pi exits 0 and the row asks
    // pi again, which now connects.
    await linear.getByRole('button', { name: 'Sign in' }).click()
    await expect(linear.getByText(/Approve access in your browser/)).toBeVisible({
      timeout: 20_000,
    })
    await writeFile(join(soloAgentDir, 'stub-mcp-approve-linear'), 'ok')
    await expect(linear.getByText('Signed in.')).toBeVisible({ timeout: 20_000 })
    await expect(linear.getByText('Up · 3 tools')).toBeVisible({ timeout: 20_000 })
    await expect(linear.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
  } finally {
    await shutdown(harness)
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('Connectors: moves pi-mcp-adapter config to pi’s built-in MCP', async () => {
  // The adapter's own file, its package, and the setting it writes to turn
  // pi's MCP off: what an existing install looks like.
  const soloAgentDir = privateAgentDir()
  await writeFile(
    join(soloAgentDir, 'mcp-adapter.json'),
    JSON.stringify({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', auth: 'oauth', lifecycle: 'lazy-keep-alive' },
        tools: { command: 'npx', args: ['tools-mcp'], directTools: true },
      },
    }),
  )
  await writeFile(
    join(soloAgentDir, 'settings.json'),
    JSON.stringify({ packages: ['npm:pi-mcp-adapter'], extensions: ['-builtin:mcp'] }),
  )
  const harness = await launch({
    agentDir: soloAgentDir,
    userDataDir: await scratchDir('phosphor-e2e-migrate-'),
  })
  const { page } = harness
  try {
    await openWorkspace(page)
    // Every launch says so, outside Settings, and the notice is the way in.
    await page.getByRole('button', { name: 'Open Connectors: Move your MCP connectors' }).click()

    // Nothing is touched until the user has read the plan and asked.
    await expect(page.getByText('Move your connectors to pi’s built-in MCP')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText('pi’s built-in MCP is turned back on.')).toBeVisible()
    await expect(page.getByText(/Sign in again afterwards to linear/)).toBeVisible()
    await expect(page.getByTestId('connector-linear')).toHaveCount(0)
    expect(existsSync(join(soloAgentDir, 'mcp.json'))).toBe(false)

    await page.getByRole('button', { name: 'Move to pi’s MCP' }).click()

    // Config first, then the package: the card goes once both are done.
    await expect(page.getByText('Move your connectors to pi’s built-in MCP')).toHaveCount(0, {
      timeout: 30_000,
    })
    const config = JSON.parse(await readFile(join(soloAgentDir, 'mcp.json'), 'utf8'))
    expect(config.mcpServers).toEqual({
      linear: { url: 'https://mcp.linear.app/mcp' },
      tools: { command: 'npx', args: ['tools-mcp'], exposure: 'direct' },
    })
    expect(existsSync(join(soloAgentDir, 'mcp-adapter.json'))).toBe(false)
    const settings = JSON.parse(await readFile(join(soloAgentDir, 'settings.json'), 'utf8'))
    expect(settings.packages).toEqual([])
    expect(settings.extensions ?? []).not.toContain('-builtin:mcp')

    await expect(page.getByTestId('connector-linear').getByText('Needs sign-in')).toBeVisible({
      timeout: 20_000,
    })
  } finally {
    await shutdown(harness)
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('reopens the last session on relaunch and continues without disturbing its draft', async () => {
  // Both launches share a userData dir so prefs survive the restart, while
  // staying isolated from the developer's real config.
  const userDataDir = await scratchDir('phosphor-e2e-prefs-')
  const workspace = await scratchDir('phosphor-e2e-')

  try {
    // First launch: open the workspace and start a session.
    const first = await launch({ workspace, userDataDir })
    try {
      await openWorkspace(first.page)
      await first.page.getByPlaceholder('Describe a task or ask a question').fill('hello')
      await first.page.getByRole('button', { name: /Start session/i }).click()
      // Session is live once the chat composer replaces the greeting composer.
      await expect(first.page.getByPlaceholder(/Describe a task…/i)).toBeVisible({
        timeout: 20_000,
      })
      // …but "live" is not "persisted": the session file path arrives with
      // get_state, after the composer renders. Closing before that lands
      // leaves no lastSessionPath and the relaunch falls back to home —
      // which is exactly how this test failed on (slower) Linux CI.
      //
      // `:not([data-pending])` is load-bearing. A live session gets a
      // PLACEHOLDER row (`PendingSessionRow`) the moment it is created, and
      // that row carries the same `session-row` testid — so a bare match was
      // satisfied before the session file existed, and the guard proved
      // nothing. It only held because starting a chat used to be slow enough
      // that the disk write won the race anyway; taking ~0.9s of git off the
      // send path made it lose. The disk-backed row is the actual signal.
      await expect(
        first.page.locator('[data-testid="session-row"]:not([data-pending])').first(),
      ).toBeVisible({ timeout: 20_000 })
    } finally {
      await first.app.close()
    }

    // Second launch: must land straight in that session, no picker.
    const second = await launch({ workspace, userDataDir })
    try {
      await expect(second.page.getByPlaceholder(/Describe a task…/i)).toBeVisible({
        timeout: 30_000,
      })
      await expect(second.page.getByRole('button', { name: /Open Folder/i })).toBeHidden()
      const composer = second.page.getByPlaceholder(/Describe a task…/i)
      const continueButton = second.page.getByRole('button', { name: 'Continue', exact: true })
      const sendButton = second.page.getByRole('button', { name: 'Send message', exact: true })
      await expect(continueButton).toBeEnabled()
      await expect(sendButton).toBeDisabled()
      // Continue sits immediately left of Send, behind a hairline.
      const order = await second.page.evaluate(() =>
        [...document.querySelectorAll('[aria-label="Continue"], [aria-label="Send message"]')].map(
          (el) => el.getAttribute('aria-label'),
        ),
      )
      expect(order).toEqual(['Continue', 'Send message'])
      await composer.fill('Keep this draft for later')
      await continueButton.click()
      await expect(
        second.page.getByTestId('user-message').getByText('continue', { exact: true }),
      ).toBeVisible()
      await expect(second.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
      await expect(continueButton).toBeDisabled()
      await expect(continueButton).toBeEnabled({ timeout: 20_000 })
      await expect(composer).toHaveValue('Keep this draft for later')
      await second.page.screenshot({ path: test.info().outputPath('continue-button.png') })
    } finally {
      await second.app.close()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
})

/**
 * pi's `fork` never edits a session in place: a rewind moves the chat onto a
 * new file and leaves the old one on disk, with the same title. Phosphor
 * records the rewind and folds the old file away; opened some other way, the
 * old file says where the chat went. Fork and Clone keep both files (see the
 * startup spec's "saved fork" test).
 */
test('a rewind leaves one sidebar row, and its old file points at the new one', async () => {
  const h = await launch()
  const { page } = h
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    const reply = page.getByText(/Done:\s*hello\.ts\s*updated\./)
    await expect(reply).toBeVisible({ timeout: 30_000 })
    const rows = page.getByTestId('session-row')
    const saved = page.locator('[data-testid="session-row"]:not([data-pending])')
    await expect(saved).toHaveCount(1, { timeout: 20_000 })

    // Rewind to the first message, then resend it: pi writes the new file
    // only when that turn ends.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+k`)
    await page.getByPlaceholder('Type a command…').fill('Rewind')
    await page.getByText('Rewind to an earlier message…').click()
    await page.getByRole('button', { name: /stub session/ }).click()
    const composer = page.getByPlaceholder(/Describe a task…/i)
    await expect(composer).toHaveText('stub session')
    // Before the resend the new file is not on disk yet. The live session's
    // placeholder is the chat's one row; the old file must not sit beside it.
    await expect(saved).toHaveCount(0)
    await expect(rows).toHaveCount(1)
    await composer.press('Enter')
    await expect(reply).toHaveCount(1, { timeout: 30_000 })

    for (let reload = 0; reload < 2; reload++) {
      await expect(saved).toHaveCount(1, { timeout: 20_000 })
      await expect(rows).toHaveCount(1)
      await page.reload()
    }
    await expect(saved).toHaveCount(1, { timeout: 20_000 })

    // The old file still carries the stub's auto-name (the rewind went back
    // past it), is still reachable, and says where the chat went.
    await page.keyboard.press(`${mod}+k`)
    await page.getByPlaceholder('Type a command…').fill('Open session: Stub Session Title')
    await page.getByText('Open session: Stub Session Title', { exact: true }).click()
    const banner = page.getByTestId('rewound-banner')
    await expect(banner).toContainText('This is the chat before a rewind. It continues in', {
      timeout: 20_000,
    })
    // Live again, so it is listed again: never hide the row being looked at.
    await expect(saved).toHaveCount(2)
    await banner.getByRole('button').click()
    await expect(banner).toBeHidden()
  } finally {
    await shutdown(h)
  }
})

test('an unsent draft survives a session switch and a relaunch', async () => {
  // One userData dir across both launches so the draft has somewhere to live,
  // while staying out of the developer's real prefs.
  const userDataDir = await scratchDir('phosphor-e2e-prefs-')
  const workspace = await scratchDir('phosphor-e2e-')

  try {
    const first = await launch({ workspace, userDataDir })
    try {
      await openWorkspace(first.page)
      const home = first.page.getByPlaceholder('Describe a task or ask a question')

      // Type a first-prompt draft and paste an image into it.
      await home.fill('half-written thought')
      await first.page.evaluate((pngB64: string) => {
        const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(new File([bytes], 'dot.png', { type: 'image/png' }))
        const zone = document
          .querySelector<HTMLTextAreaElement>(
            'textarea[placeholder^="Describe a task or ask a question"]',
          )!
          .closest('div.relative')!
        zone.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }),
        )
        zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
      }, PNG_1X1)
      await expect(
        first.page.getByRole('button', { name: 'Attached image', exact: true }),
      ).toBeVisible()

      // Start a session in a SECOND composer, then come back. This is the
      // case local state could never survive: App keys ChatView on the active
      // session id, so navigating away unmounted the composer entirely.
      await first.page.getByRole('button', { name: /^New$/ }).click()
      await expect(first.page.getByPlaceholder('Describe a task or ask a question')).toHaveValue(
        'half-written thought',
      )

      // Writes are debounced, so wait for the draft to actually be in prefs
      // before pulling the plug — a fixed sleep here would be a flake waiting
      // to happen on slower CI.
      await expect
        .poll(
          () =>
            first.page.evaluate(async () => {
              const prefs = await window.phosphor.invoke('app:getPrefs')
              return Object.keys(prefs.drafts).length
            }),
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0)
    } finally {
      await first.app.close()
    }

    const second = await launch({ workspace, userDataDir })
    try {
      const home = second.page.getByPlaceholder('Describe a task or ask a question')
      await expect(home).toBeVisible({ timeout: 30_000 })
      await expect(home).toHaveValue('half-written thought', { timeout: 20_000 })
      // The image came back too — its bytes live beside prefs, not in them.
      await expect(
        second.page.getByRole('button', { name: 'Attached image', exact: true }),
      ).toBeVisible({ timeout: 20_000 })
    } finally {
      await second.app.close()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('lane marker picker works offline and persists choices across marker modes', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    const row = page.locator('[data-testid="session-row"]:not([data-pending])').first()
    const marker = row.getByTestId('lane-marker')
    await expect(marker).toBeVisible({ timeout: 20_000 })
    const auto = await marker.textContent()
    const picker = page.getByRole('dialog', { name: 'Lane marker', exact: true })
    const setMode = async (mode: string): Promise<void> => {
      await page.getByRole('button', { name: /^Settings/ }).click()
      await page.getByRole('button', { name: 'Workspaces', exact: true }).click()
      await page.getByRole('button', { name: mode, exact: true }).click()
      await page.keyboard.press('Escape')
    }
    await page.context().setOffline(true)
    await marker.click()
    await expect(picker.getByRole('textbox', { name: 'Search icons' })).toBeFocused()
    await expect(picker.locator('button[aria-pressed]')).toHaveCount(120)
    await picker.getByRole('button', { name: 'Show more icons' }).click()
    await expect(picker.locator('button[aria-pressed]')).toHaveCount(240)
    await picker.getByRole('combobox').selectOption('Travel & Places')
    await picker.getByRole('textbox').fill('not-an-emoji-name')
    await expect(picker.getByRole('status')).toContainText('No icons found')
    await picker.getByRole('textbox').fill('satellite')
    await picker.getByRole('button', { name: 'satellite', exact: true }).click()
    await expect(marker).toHaveText('🛰️')
    await expect(picker).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(async () =>
          Object.values((await window.phosphor.invoke('app:getPrefs')).laneMarkers),
        ),
      )
      .toContain('🛰️')
    await page.reload()
    await expect(marker).toHaveText('🛰️', { timeout: 30_000 })
    await setMode('off')
    await expect(marker).toHaveCount(0)
    await page.reload()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(marker).toHaveCount(0)
    await row.click({ button: 'right' })
    await expect(page.getByRole('button', { name: 'Lane marker…', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await setMode('manual')
    await expect(marker).toHaveText('🛰️')
    await row.click({ button: 'right' })
    await page.getByRole('button', { name: 'Lane marker…', exact: true }).click()
    await picker.getByRole('button', { name: 'Default', exact: true }).click()
    await expect(marker).toHaveText('•')
    await setMode('auto')
    await expect(marker).toHaveText(auto!)
    await marker.click()
    await picker.getByRole('button', { name: 'None', exact: true }).click()
    await expect(marker).toHaveText('•')
    await marker.click()
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(marker).toHaveText('•')
    await marker.click()
    await picker.getByRole('button', { name: /Auto/ }).click()
    await expect(marker).toHaveText(auto!)
  } finally {
    await shutdown(harness)
  }
})

test('lane rows carry no spend, and the row menu still offers it', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible({ timeout: 30_000 })
    // `:not([data-pending])` is load-bearing, as it is at the relaunch test
    // above. A live session keeps its PLACEHOLDER row for the whole first
    // turn, that row carries the same `session-row` testid, and its menu is a
    // different, shorter one — Open / Rename / Export HTML, no spend. A bare
    // match took the placeholder and the assertion below could never pass.
    const row = page.locator('[data-testid="session-row"]:not([data-pending])').first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    // The stub bills a real (small) cost, so a row that shows spend would show
    // it here — the trailer is gone, not merely empty.
    await expect(row).not.toContainText('$')
    // Spend reaches the row through a disk rescan, which lands after the reply
    // text does, and a context menu builds its items once at open — so a menu
    // opened too early stays wrong however long the locator waits. Re-open it
    // until the scan has caught up.
    await expect
      .poll(
        async () => {
          await row.click({ button: 'right' })
          return page.getByRole('button', { name: /^Copy spend/ }).count()
        },
        { timeout: 20_000 },
      )
      .toBe(1)
  } finally {
    await shutdown(harness)
  }
})

test('sidebar session drag, menu and keyboard order survives suspend and restart', async () => {
  const userDataDir = await scratchDir('phosphor-e2e-order-')
  const first = await launch({ userDataDir })
  const { page, workspace } = first
  let expected: string[]
  try {
    await openWorkspace(page)
    for (let i = 1; i <= 3; i++) {
      await page.getByPlaceholder('Describe a task or ask a question').fill(`Ordering session ${i}`)
      await page.getByRole('button', { name: /Start session/i }).click()
      await expect(page.locator('[data-testid="session-row"]:not([data-pending])')).toHaveCount(i, {
        timeout: 30_000,
      })
      await page.getByRole('button', { name: /^New$/ }).click()
    }
    const rows = page.locator('[data-session-path]')
    const order = () =>
      rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-session-path')!))
    const original = await order()
    const last = page.locator(`[data-session-path="${original[2]}"]`)
    const from = (await last.boundingBox())!
    const to = (await rows.first().boundingBox())!
    await page.mouse.move(from.x + 80, from.y + 10)
    await page.mouse.down()
    await page.mouse.move(to.x + 80, to.y + 2, { steps: 8 })
    await page.mouse.move(to.x + 80, to.y + 3)
    await expect(page.locator('[data-drop]')).toHaveCount(1)
    expect(await order()).toEqual(original) // Hover paints an indicator, not a reordered tree.
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.locator('[data-drop], [data-dragging]')).toHaveCount(0)
    expect(await order()).toEqual(original)
    await last.dragTo(rows.first(), { targetPosition: { x: 80, y: 2 } })
    expected = [original[2]!, original[0]!, original[1]!]
    await expect.poll(order).toEqual(expected)
    // Dragging never activates or resumes a session.
    await expect(page.getByPlaceholder('Describe a task or ask a question')).toBeVisible()
    await last.getByTestId('session-row').click({ button: 'right' })
    await page.getByRole('button', { name: /^Move down/ }).click()
    await expect.poll(order).toEqual([original[0], original[2], original[1]])
    await last.getByTestId('session-row').focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(order).toEqual(original)
    await expect(last.getByTestId('session-row')).toBeFocused()
    await last.getByTestId('session-row').click({ button: 'right' })
    await page.getByRole('button', { name: /^Suspend/ }).click()
    await expect(last).toContainText('suspended')
    await last.dragTo(rows.first(), { targetPosition: { x: 80, y: 2 } })
    await expect.poll(order).toEqual(expected)
    await last.getByTestId('session-row').click()
    await expect(last).not.toContainText('suspended')
    await expect.poll(order).toEqual(expected)
    // An external/other-section drag must not reorder the destination list.
    const pinned = rows.last()
    const pinnedPath = await pinned.getAttribute('data-session-path')
    await pinned.getByTestId('session-row').click({ button: 'right' })
    await page.getByRole('button', { name: /^Pin$/ }).click()
    // Snapshot only once the pin has rendered: Pinned is the first section.
    await expect(rows.first()).toHaveAttribute('data-session-path', pinnedPath!)
    const before = await order()
    await page.locator(`[data-session-path="${pinnedPath}"]`).dragTo(last)
    await expect.poll(order).toEqual(before)
    await page
      .locator(`[data-session-path="${pinnedPath}"]`)
      .getByTestId('session-row')
      .click({ button: 'right' })
    await page.getByRole('button', { name: /^Unpin$/ }).click()
    await expect.poll(order).toEqual(expected)
  } finally {
    await first.app.close()
  }
  const second = await launch({ workspace, userDataDir })
  try {
    await expect(second.page.locator('[data-session-path]')).toHaveCount(3, { timeout: 30_000 })
    expect(
      await second.page
        .locator('[data-session-path]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-session-path'))),
    ).toEqual(expected)
  } finally {
    await shutdown(second)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('sidebar groups sessions from several workspaces and badges pinned rows', async () => {
  // Two projects, one shared prefs store so both stay in "known workspaces".
  const userDataDir = await scratchDir('phosphor-e2e-prefs-')
  const workspaceA = await scratchDir('phosphor-e2e-a-')
  const workspaceB = await scratchDir('phosphor-e2e-b-')
  const nameA = workspaceA.split('/').pop()!
  const nameB = workspaceB.split('/').pop()!

  try {
    // Session in workspace A.
    const first = await launch({ workspace: workspaceA, userDataDir })
    try {
      await openWorkspace(first.page)
      await first.page.getByPlaceholder('Describe a task or ask a question').fill('work in A')
      await first.page.getByRole('button', { name: /Start session/i }).click()
      await expect(first.page.getByPlaceholder(/Describe a task…/i)).toBeVisible({
        timeout: 20_000,
      })
      // A live composer is not a persisted session: the file path arrives with
      // get_state, after the composer renders, and closing before it lands
      // leaves no lastSessionPath — so the relaunch below opens the picker and
      // never restores A. Same race the relaunch test guards against; wait for
      // the sidebar row, which only appears once the session is on disk.
      await expect(first.page.getByTestId('session-row').first()).toBeVisible({
        timeout: 20_000,
      })
    } finally {
      await first.app.close()
    }

    // Session in workspace B — A must remain listed alongside it.
    const second = await launch({ workspace: workspaceB, userDataDir })
    try {
      // The app restores A's session, so explicitly switch to B via the
      // workspace switcher — the same path a user takes.
      await expect(second.page.getByPlaceholder(/Describe a task…/i)).toBeVisible({
        timeout: 30_000,
      })
      await second.page.getByRole('button', { name: /^New$/ }).click()
      await expect(second.page.getByTestId('workspace-chip')).toBeVisible({ timeout: 20_000 })
      await second.page.getByTestId('workspace-chip').click()
      await second.page.getByText('Open folder…').click()
      await expect(second.page.getByPlaceholder('Describe a task or ask a question')).toBeVisible({
        timeout: 20_000,
      })
      await second.page.getByPlaceholder('Describe a task or ask a question').fill('work in B')
      await second.page.getByRole('button', { name: /Start session/i }).click()
      await expect(second.page.getByPlaceholder(/Describe a task…/i)).toBeVisible({
        timeout: 20_000,
      })

      // Both workspaces appear as sidebar groups.
      const groups = second.page.getByTestId('workspace-group')
      await expect(groups.filter({ hasText: nameA })).toBeVisible({ timeout: 20_000 })
      await expect(groups.filter({ hasText: nameB })).toBeVisible()

      // Starting in B must not promote it over A. The header overflow menu is
      // the sole control that changes the user-defined workspace order.
      await expect(groups).toHaveCount(2)
      expect(await groups.allTextContents()).toEqual([nameA, nameB])
      const groupB = groups.filter({ hasText: nameB })
      await groupB.locator('..').getByTestId('workspace-group-menu').click()
      await second.page.getByRole('button', { name: 'Move up' }).click()
      expect(await groups.allTextContents()).toEqual([nameB, nameA])

      // Pin a session from B's group; it moves to Pinned and gains a
      // workspace badge — the badge is what identifies a project once the
      // group no longer does.
      const sessionRow = second.page
        .locator(`[data-testid="session-row"][data-workspace="${nameB}"]`)
        .first()
      await sessionRow.click({ button: 'right' })
      await second.page.getByRole('button', { name: /^Pin$/ }).click()

      await expect(second.page.getByText('Pinned')).toBeVisible()
      const badge = second.page.getByTestId('session-workspace-badge').first()
      await expect(badge).toBeVisible()
      await expect(badge).toHaveText(nameB)
    } finally {
      await second.app.close()
    }
  } finally {
    await rm(workspaceA, { recursive: true, force: true })
    await rm(workspaceB, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('home composer: grey focus border, top-bar chip popovers, and model picker', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    const composer = page.getByPlaceholder('Describe a task or ask a question')
    const card = page.locator('.composer-field').first().locator('..')

    // Regression: focus must never draw the accent ring. The global
    // :focus-visible rule used to paint a 2px orange outline over the whole
    // composer; the card's own border is the only focus signal.
    await composer.click()
    await expect(composer).toBeFocused()
    const focusOutline = await composer.evaluate((el) => getComputedStyle(el).outlineStyle)
    expect(focusOutline).toBe('none')

    // Border shifts one small step on focus, and stays grey (r≈g≈b) rather
    // than picking up the terracotta accent.
    const focused = await card.evaluate((el) => {
      // Settle the colour transition before sampling.
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve(getComputedStyle(el).borderTopColor), 600)
      })
    })
    const [r, g, b] = focused.match(/\d+/g)!.map(Number) as [number, number, number]
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(24)

    // Every chip opens a popover. (The informational "Local" chip was removed —
    // Phosphor only ever runs pi as a local subprocess. On the home screen the
    // folder and branch chips sit above the composer and the top bar shows
    // neither, so "which folder / which branch" still has exactly one answer.)
    await expect(page.getByRole('banner').getByTestId('workspace-chip')).toHaveCount(0)
    await page.getByTestId('workspace-chip').click()
    await expect(page.getByText(/Open folder/)).toBeVisible()
    // PopupMenu dismisses on outside mousedown.
    await page.mouse.click(20, 400)
    await expect(page.getByText(/Open folder/)).toBeHidden()

    // Attachment affordance is present next to the pickers.
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('model picker: lexical search across providers, family grouping, stars', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    await page.getByTestId('home-model-picker').click()
    const search = page.getByTestId('model-search')
    await expect(search).toBeVisible()
    const rows = page.getByTestId('model-row')

    // The catalogue offers Claude Opus 5 four ways: pi's native provider, the
    // Claude Code CLI provider, and two Bedrock entries. One family header,
    // four routes — the case a flat list of identical names cannot express.
    await search.fill('opus')
    await expect(rows).toHaveCount(4)
    // The header is uppercased in CSS only, so match the underlying text.
    await expect(page.getByTestId('model-list')).toContainText('Claude Opus 5')
    // Every row names its provider, because the display names are identical.
    await expect(rows.nth(0)).toContainText('anthropic')

    // Terms AND together in any order, and `aws` resolves to amazon-bedrock —
    // a provider nobody spells out in full.
    await search.fill('opus aws')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'amazon-bedrock' })).toHaveCount(2)
    await search.fill('aws opus')
    await expect(rows).toHaveCount(2)

    // The bare Bedrock foundation id stays visible and stays unselectable:
    // hiding it would make "where did Opus go?" unanswerable.
    await expect(rows.filter({ hasText: /inference profile/ })).toHaveCount(1)
    await expect(rows.first()).toBeDisabled()

    // Separators are noise.
    await search.fill('opus-5')
    await expect(rows).toHaveCount(4)

    // Negation and field qualifiers.
    await search.fill('opus -aws')
    await expect(rows).toHaveCount(2)
    await search.fill('provider:openai')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-tooltip', 'openai/gpt-5')

    // A miss says so rather than falling back to the whole catalogue.
    await search.fill('llama')
    await expect(rows).toHaveCount(0)
    await expect(page.getByText(/No models match/)).toBeVisible()

    // Starring survives closing and reopening the menu.
    await search.fill('provider:openai')
    await page
      .getByRole('button', { name: /^Star / })
      .first()
      .click()
    await page.keyboard.press('Escape')
    await page.getByTestId('home-model-picker').click()
    await expect(page.getByTestId('model-list')).toContainText('Starred')
    // Twice: once in the Starred shortcut, once in its place in the catalogue.
    await expect(page.getByRole('button', { name: /^Unstar GPT-5$/ })).toHaveCount(2)
  } finally {
    await shutdown(harness)
  }
})

test('semantic HTML artifacts stay readable in a narrow panel in both themes', async () => {
  const h = await launch()
  try {
    // Test rendered styles, not Chromium's native disclosure interaction.
    // Start expanded so layout assertions include the disclosure's content.
    const html = `<article class="art-document"><h1>Host entry point</h1><p>Run the shared runtime without Electron.</p>
      <p><code>${'libs/session-runtime/'.repeat(12)}</code></p>
      <pre><code>${'long_command_argument '.repeat(30)}</code></pre>
      <dl><dt>Scope</dt><dd>CLI and lifecycle</dd></dl>
      <details open><summary>Acceptance</summary><p>Run the headless probe.</p></details>
      <table><thead><tr><th>Field</th><th>Value</th></tr></thead>
        <tbody><tr><td>Key</td><td style="white-space:nowrap">${'value '.repeat(60)}</td></tr></tbody></table>
      <div class="kpis"><div class="kpi">Legacy metric</div></div>
      <div class="rail"><div class="node"><div class="gut"></div><div class="body">Legacy step</div></div></div></article>`
    for (const theme of ['light', 'dark'] as const) {
      await h.page.evaluate(
        async ({ html, theme }) => {
          document.querySelector('#artifact-style-test')?.remove()
          const iframe = document.createElement('iframe')
          iframe.id = 'artifact-style-test'
          iframe.setAttribute('sandbox', 'allow-scripts')
          iframe.style.cssText =
            'position:fixed;inset:0;width:380px;height:700px;border:0;z-index:9999'
          iframe.src = await window.phosphor.invoke('artifacts:stageHtml', html, theme)
          document.body.append(iframe)
        },
        { html, theme },
      )
      const frame = h.page.frameLocator('#artifact-style-test')
      await expect(frame.getByRole('heading', { name: 'Host entry point' })).toBeVisible()
      await expect(frame.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(frame.locator('html')).toHaveCSS(
        'background-color',
        theme === 'light' ? 'rgb(247, 247, 248)' : 'rgb(30, 28, 24)',
      )
      const layout = await frame.locator('body').evaluate((body) => ({
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        codeScrolls:
          body.querySelector('pre')!.scrollWidth > body.querySelector('pre')!.clientWidth,
        tableScrolls:
          body.querySelector('table')!.scrollWidth > body.querySelector('table')!.clientWidth,
        paragraphFont: getComputedStyle(body.querySelector('p')!).fontFamily,
      }))
      expect(layout.page).toBeLessThanOrEqual(layout.viewport)
      expect(layout.codeScrolls).toBe(true)
      expect(layout.tableScrolls).toBe(true)
      expect(layout.paragraphFont).not.toContain('monospace')
      await expect(frame.getByText('Run the headless probe.')).toBeVisible()
      await expect(frame.locator('.kpis')).toHaveCSS('display', 'grid')
      await expect(frame.locator('.rail')).toHaveCSS('display', 'grid')
      await expect(frame.locator('.rail .node')).toHaveCSS('display', 'grid')
      await h.page.locator('#artifact-style-test').evaluate((element) => {
        ;(element as HTMLIFrameElement).style.width = '1100px'
      })
      await expect
        .poll(() => frame.locator('.art-document').evaluate((article) => article.clientWidth))
        .toBeLessThan(900)
    }
  } finally {
    await shutdown(h)
  }
})

test('HTML prototypes use the viewport at narrow, tablet and fullscreen widths', async () => {
  const h = await launch()
  try {
    // Reduced from the reported prototype: body resets margin, not an unknown
    // injected max-width/padding. Breakpoints assume the viewport is usable.
    const fragment = `<style>
      body{margin:0}
      #demo{min-height:100vh;display:grid;grid-template-columns:174px minmax(0,1fr)}
      #demo main{min-width:0;padding:16px}
      #demo .columns{display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:24px}
      @media(max-width:1000px){#demo .columns{grid-template-columns:1fr}}
      @media(max-width:650px){#demo{grid-template-columns:1fr}#navigation{display:none}}
      </style><div id="demo"><nav id="navigation">Navigation</nav><main>
      <h1>Responsive prototype</h1><div class="columns"><section>Decisions</section>
      <aside class="rail">Activity</aside></div>
      <button onclick="this.textContent='Opened'">Open</button></main></div>`
    for (const theme of ['light', 'dark'] as const) {
      for (const full of [false, true]) {
        const html = full
          ? `<!doctype html><html><head><title>Prototype</title></head><body>${fragment}</body></html>`
          : fragment
        await h.page.evaluate(
          async ({ html, theme }) => {
            document.querySelector('#responsive-artifact')?.remove()
            const iframe = document.createElement('iframe')
            iframe.id = 'responsive-artifact'
            iframe.setAttribute('sandbox', 'allow-scripts')
            iframe.style.cssText =
              'position:fixed;inset:0;width:380px;height:350px;border:0;z-index:9999'
            iframe.src = await window.phosphor.invoke('artifacts:stageHtml', html, theme)
            document.body.append(iframe)
          },
          { html, theme },
        )
        const frame = h.page.frameLocator('#responsive-artifact')
        await expect(frame.getByRole('heading', { name: 'Responsive prototype' })).toBeVisible()
        await expect(frame.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(frame.locator('.rail')).toHaveCSS('display', 'block')
        for (const width of [380, 800, 1600]) {
          await h.page.locator('#responsive-artifact').evaluate((element, width) => {
            ;(element as HTMLIFrameElement).style.width = `${width}px`
          }, width)
          await expect
            .poll(() =>
              frame.locator('#demo').evaluate((demo) => ({
                width: demo.getBoundingClientRect().width,
                height: demo.getBoundingClientRect().height,
                x: demo.getBoundingClientRect().x,
                y: demo.getBoundingClientRect().y,
                overflow: document.documentElement.scrollWidth > window.innerWidth,
              })),
            )
            .toEqual({ width, height: 350, x: 0, y: 0, overflow: false })
          await expect(frame.locator('#navigation')).toHaveCSS(
            'display',
            width <= 650 ? 'none' : 'block',
          )
          const columns = await frame
            .locator('.columns')
            .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' '))
          expect(columns).toHaveLength(width <= 1000 ? 1 : 2)
        }
        await frame.getByRole('button', { name: 'Open', exact: true }).click()
        await expect(frame.getByRole('button', { name: 'Opened', exact: true })).toBeVisible()
      }
    }
  } finally {
    await shutdown(h)
  }
})

test('HTML artifact iframe fits its pane, fullscreen and a short viewport', async () => {
  const h = await launch()
  try {
    await openWorkspace(h.page)
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('Update hello.ts')
    await h.page.getByRole('button', { name: /Start session/i }).click()
    const scroller = h.page.getByTestId('artifact-scroll')
    const iframe = scroller.locator('iframe')
    await expect(iframe).toBeVisible({ timeout: 30_000 })
    const expectFit = async (): Promise<void> => {
      await expect
        .poll(() =>
          scroller.evaluate((element) => {
            // Staging can briefly render a placeholder during a pane transition.
            // Return a non-match so polling waits, rather than throwing on null.
            const frame = element.querySelector('iframe')
            if (!frame) return null
            return {
              width: frame.offsetWidth - element.clientWidth,
              height: frame.offsetHeight - element.clientHeight,
              scroll: element.scrollHeight - element.clientHeight,
            }
          }),
        )
        .toEqual({ width: 0, height: 0, scroll: 0 })
    }
    await expectFit()
    const narrow = (await iframe.boundingBox())!.width
    await h.page.getByRole('button', { name: 'Fullscreen pane', exact: true }).click()
    await expect.poll(async () => (await iframe.boundingBox())?.width ?? 0).toBeGreaterThan(narrow)
    await expectFit()
    // A short split pane must not silently become a 400px iframe viewport.
    await scroller.evaluate((element) => {
      element.style.flex = 'none'
      element.style.height = '240px'
    })
    await expectFit()
    expect((await iframe.boundingBox())!.height).toBe(240)
  } finally {
    await shutdown(h)
  }
})

test('artifact pane scrolls a long document', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page
      .getByPlaceholder('Describe a task or ask a question')
      .fill('write a longartifact please')
    await page.getByRole('button', { name: /Start session/i }).click()

    // The artifact tool card carries the artifact's identity now, not a
    // generic "Used artifact_create" row. Tool rows live inside the turn's
    // activity group, which collapses once the run settles.
    // Wait for the run to settle (the group auto-collapses) before expanding —
    // reading aria-expanded while it is still live races that transition.
    const summary = page.getByTestId('activity-summary').first()
    await expect(summary).toBeVisible({ timeout: 30_000 })
    await expect(summary).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
    await summary.click()
    const card = page.getByRole('button', { name: /Created artifact\s+E2E Long Doc/ })
    await expect(card).toBeVisible({ timeout: 30_000 })

    // The artifacts pane auto-opens on the session's first artifact, so don't
    // click the header toggle here — that would close it again.
    const scroller = page.getByTestId('artifact-scroll')
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    // Regression: the pane used to clip its body with no scrollbar at all, so
    // everything past the first screen of a long artifact was unreachable.
    const metrics = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 200)

    const moved = await scroller.evaluate((el) => {
      el.scrollTop = 400
      return el.scrollTop
    })
    expect(moved).toBeGreaterThan(0)
  } finally {
    await shutdown(harness)
  }
})

test('transcript: reading back during a stream is not undone, and rows sit flush', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('do a longstream now')
    await page.getByRole('button', { name: /Start session/i }).click()

    const scroller = page.getByTestId('transcript-scroll')
    await expect(scroller).toBeVisible({ timeout: 30_000 })

    // An unidentified streaming tool must never surface as a literal name.
    // The anonymous window is a few stub ticks wide and adoption closes it,
    // so a point-in-time count-0 assertion passes vacuously (verified: it
    // stayed green with "Running unknown" restored). Watch the whole stream
    // with a MutationObserver instead, and assert at the end.
    await page.evaluate(() => {
      const w = window as unknown as { __sawUnknown?: boolean }
      w.__sawUnknown = /unknown/i.test(document.body.innerText)
      new MutationObserver(() => {
        if (/unknown/i.test(document.body.innerText)) w.__sawUnknown = true
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await expect(page.locator('.tool-card').first()).toBeVisible({ timeout: 30_000 })

    // Wait until the transcript overflows, then read back.
    await expect
      .poll(async () => await scroller.evaluate((el) => el.scrollHeight - el.clientHeight), {
        timeout: 30_000,
      })
      .toBeGreaterThan(300)

    const box = (await scroller.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -400)

    // Keep streaming: geometry-derived pinning used to re-pin right here (the
    // virtualizer re-measures, scrollHeight shrinks, scrollTop is clamped to
    // the bottom) and slam the viewport back down mid-sentence.
    await page.waitForTimeout(1200)
    const position = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }))
    expect(position.max - position.top).toBeGreaterThan(100)
    // The app agrees it is no longer following the tail. The pill labels the
    // ACTION (it only renders while unpinned), never the current state.
    await expect(page.getByRole('button', { name: /Follow stream|Jump to bottom/ })).toBeVisible()

    // …and no fabricated tool name ever appeared during the whole stream.
    expect(
      await page.evaluate(() => (window as unknown as { __sawUnknown: boolean }).__sawUnknown),
    ).toBe(false)
  } finally {
    await shutdown(harness)
  }
})

test('transcript: reading back through a finished transcript is never fought', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('do manyturns now')
    await page.getByRole('button', { name: /Start session/i }).click()

    const scroller = page.getByTestId('transcript-scroll')
    await expect(page.getByText('many turns complete')).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => await scroller.evaluate((el) => el.scrollHeight - el.clientHeight), {
        timeout: 30_000,
      })
      .toBeGreaterThan(2000)

    const box = (await scroller.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    // Walk up the way a reader does: many small wheel notches, not one jump.
    // Every notch must move the viewport UP. The regression this covers is the
    // virtualizer compensating the estimate→actual delta of each row entering
    // from the top, which shoves scrollTop back down by hundreds of pixels and
    // makes a long transcript impossible to read back.
    let previous = await scroller.evaluate((el) => el.scrollTop)
    const start = previous
    let fought = 0
    for (let i = 0; i < 25; i++) {
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(80)
      const top = await scroller.evaluate((el) => el.scrollTop)
      if (top > previous + 1) fought += 1
      previous = top
    }

    expect(fought).toBe(0)
    expect(previous).toBeLessThan(start - 1000)

    // Nothing re-pins it afterwards either.
    await page.waitForTimeout(600)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(start - 1000)
    await expect(page.getByRole('button', { name: /Follow stream|Jump to bottom/ })).toBeVisible()

    // Flicking back down to the tail resumes the follow with no pill click:
    // the scroll lands long after the last wheel event, so the gesture is
    // settled at `scrollend` rather than inferred from geometry.
    await page.mouse.wheel(0, 5000)
    await page.waitForTimeout(600)
    await expect(page.getByRole('button', { name: /Follow stream|Jump to bottom/ })).toBeHidden()
    const tail = await scroller.evaluate(scrollPosition)
    expect(tail.top).toBe(tail.max)
  } finally {
    await shutdown(harness)
  }
})

test('transcript: a settling run cannot drag a reader back to the tail', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    // A tall run of tools at the very end of the transcript, held live and
    // expanded for a few seconds. When it settles the group collapses and the
    // transcript loses ~700px BELOW the reader — the shrink that used to clamp
    // scrollTop and drop them at the new bottom.
    await page
      .getByPlaceholder('Describe a task or ask a question')
      .fill('do manyturns tailgroup now')
    await page.getByRole('button', { name: /Start session/i }).click()

    const scroller = page.getByTestId('transcript-scroll')
    await expect(scroller).toBeVisible({ timeout: 30_000 })
    const tailGroup = page.locator('[data-testid="activity-group"][data-live="true"]').last()
    // Wait for the burst to actually finish streaming, not just cross a
    // height threshold: >600px can be true a dozen tool calls before the
    // group's final height, and on a loaded runner that leaves most of the
    // stub's hold still to be consumed by rendering the REST of the burst —
    // squeezing the window this test depends on almost to nothing. Poll for
    // two consecutive stable reads instead, so the wheel only fires once
    // growth has genuinely stopped and the fixed hold hasn't started ticking
    // it away yet.
    let previousHeight = -1
    await expect
      .poll(
        async () => {
          const current = await tailGroup.evaluate((el) => el.getBoundingClientRect().height)
          const stable = current > 600 && current === previousHeight
          previousHeight = current
          return stable
        },
        { timeout: 30_000, intervals: [120] },
      )
      .toBe(true)

    // Read back a few hundred px — less than the pending collapse, so a clamp
    // would be visible. Poll rather than sample once: the group is still live
    // when the wheel fires, so a loaded runner can leave the wheel event's own
    // handler queued behind the tail group's render churn well past a fixed
    // wait — same reasoning as the group-height poll above, applied to the
    // read-back itself.
    const box = (await scroller.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -360)
    let read = { top: 0, fromBottom: 0 }
    await expect
      .poll(
        async () => {
          read = await scroller.evaluate((el) => ({
            top: Math.round(el.scrollTop),
            fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          }))
          return read.fromBottom
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThan(200)
    // The collapse must still be ahead of us, or this test proves nothing.
    await expect(tailGroup).toBeVisible()
    await expect(page.getByText('many turns complete')).toHaveCount(0)

    // Let the run settle and the group collapse.
    await expect(page.getByText('many turns complete')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1500)

    // Nothing above the reader changed, so the reader must not have moved at
    // all. Before the fix the clamp took the whole read-back.
    const after = await scroller.evaluate((el) => Math.round(el.scrollTop))
    expect(Math.abs(after - read.top)).toBeLessThan(8)
    await expect(page.getByRole('button', { name: /Follow stream|Jump to bottom/ })).toBeVisible()

    // …and the reserved tail is not a trap: jumping to the bottom releases it
    // and lands on the real end of the transcript.
    await page.getByRole('button', { name: /Follow stream|Jump to bottom/ }).click()
    await page.waitForTimeout(400)
    const end = await scroller.evaluate(scrollPosition)
    expect(end.top).toBe(end.max)
    await expect(page.getByText('many turns complete')).toBeInViewport()
  } finally {
    await shutdown(harness)
  }
})

test('a long tool run collapses to one dense group', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    // 40 tool-only turns: the shape a long agent run takes, and the only shape
    // where grouping and per-row spacing actually show up.
    await page.getByPlaceholder('Describe a task or ask a question').fill('run manyitems now')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText('many items complete')).toBeVisible({ timeout: 60_000 })

    // pi emits one assistant message per tool call, so this run arrives as ~40
    // messages. They must render as ONE activity row — that regression is what
    // made long runs march down the page.
    await expect(page.getByTestId('activity-group')).toHaveCount(1)
    const summary = page.getByTestId('activity-summary').first()
    await expect(summary).toContainText(/\d+ steps/)

    // Settled ⇒ collapsed: the whole run costs a single line until asked for.
    await expect(summary).toHaveAttribute('aria-expanded', 'false')

    /*
     * Poll, don't sample once.
     *
     * The body collapses via a 220ms `grid-template-rows: 1fr → 0fr`
     * transition, and the instant `aria-expanded` flips to "false" is the
     * instant that transition STARTS. A single `evaluate` right after it
     * therefore measures the group mid-collapse — CI read 61px of a group that
     * settles at ~33px (one ActivityRow still in the track). Polling keeps the
     * assertion meaningful (a group that genuinely stays tall still fails on
     * timeout) without racing the animation.
     */
    const groupHeight = async (): Promise<number> =>
      await page.evaluate(
        () =>
          document.querySelector('[data-testid="activity-group"]')?.getBoundingClientRect()
            .height ?? 0,
      )
    await expect.poll(groupHeight, { timeout: 5_000 }).toBeLessThan(44)

    await summary.click()
    // Same transition, opening: measuring mid-expand compresses the rows and
    // would make the density assertions below pass vacuously. Wait for the
    // height to stop changing first.
    let previous = -1
    await expect
      .poll(
        async () => {
          const current = await groupHeight()
          const stable = current > 100 && current === previous
          previous = current
          return stable
        },
        { timeout: 5_000, intervals: [120] },
      )
      .toBe(true)

    const geometry = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-index]')] as HTMLElement[]
      const sorted = rows
        .map((el) => ({ index: Number(el.dataset.index), rect: el.getBoundingClientRect() }))
        .sort((a, b) => a.index - b.index)
      let worstGap = 0
      for (let i = 1; i < sorted.length; i++) {
        const previous = sorted[i - 1]!
        const current = sorted[i]!
        if (current.index !== previous.index + 1) continue
        worstGap = Math.max(worstGap, current.rect.top - previous.rect.bottom)
      }
      // Density is now per tool card inside the group, not per virtualized row.
      const cards = [...document.querySelectorAll('.tool-card')] as HTMLElement[]
      const heights = cards.map((el) => el.getBoundingClientRect().height)
      return {
        worstGap,
        tallestCard: heights.length ? Math.max(...heights) : 0,
        cards: heights.length,
      }
    })

    expect(geometry.cards).toBeGreaterThan(3)
    // One tool line used to occupy 63px for ~20px of text (four owners of the
    // same gap at once). Inside the group a settled row is ~26px; 40px leaves
    // headroom for platform font metrics while still failing on a regression.
    expect(geometry.tallestCard).toBeLessThan(40)
    // Spacing lives *inside* each measured wrapper, so measured rows are flush.
    expect(geometry.worstGap).toBeLessThan(8)
  } finally {
    await shutdown(harness)
  }
})

test('a thought shows its headline while it streams, then folds into how long it took', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('thinkstream please')
    await page.getByRole('button', { name: /Start session/i }).click()

    // Live: the run's last row carries a timer and the newest sentence, and
    // the group's line keeps its step summary.
    const summary = page.getByTestId('activity-summary').first()
    const liveRow = page.locator('[data-testid="thought-row"][data-live="true"]').first()
    await expect(liveRow).toHaveText(/^✳Thinking \d+s · One edit, then the tests\.$/, {
      timeout: 60_000,
    })
    await expect(summary).not.toContainText('Thinking')

    await expect(page.getByText('Thought it through.')).toBeVisible({ timeout: 30_000 })
    // Settled: the run's line totals the thinking, and the row says how long
    // and what it opened with.
    await expect(summary).toContainText(/thought for \d+s/)
    await summary.click()
    const row = page.getByTestId('thought-row').first()
    await expect(row).not.toHaveAttribute('data-live', 'true')
    await expect(row).toHaveText(/Thought for \d+s·Reading the spec/)
    await expect(page.getByTestId('thought-body')).toHaveCount(0)
    await row.getByRole('button').click()
    await expect(page.getByTestId('thought-body')).toContainText('One edit, then the tests.')
  } finally {
    await shutdown(harness)
  }
})

test('a Claude fan-out is one row per sub-agent, with the ones that died named', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    // The stub replays a captured Claude Code fan-out: three `Agent` calls,
    // two of which the CLI also reports as started and finished. Eight markers,
    // three agents.
    await page.getByPlaceholder('Describe a task or ask a question').fill('fanout please')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByText('Two agents reported; one never did.')).toBeVisible({
      timeout: 60_000,
    })

    // Open the settled group; the rows live inside it.
    const summary = page.getByTestId('activity-summary').first()
    await expect(summary).toContainText(/launched 3 agents/)
    await summary.click()

    const rows = page.getByTestId('subagent-row')
    // THREE. Not eight — one row per agent, not one per marker.
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAttribute('data-status', 'completed')
    await expect(rows.nth(1)).toHaveAttribute('data-status', 'completed')
    await expect(rows.nth(2)).toHaveAttribute('data-status', 'launched')

    // A finished agent shows what it cost; the launch-only one does not
    // pretend to have done anything.
    await expect(rows.nth(0)).toContainText('Dig into pi-claude-cli internals')
    await expect(rows.nth(0)).toContainText('2 tools')
    await expect(rows.nth(2)).toContainText('Find failing AskUserQuestion session')
    await expect(rows.nth(2)).toContainText('launched')

    // The strip counts the ONE agent that never reported, not all three.
    const strip = page.getByTestId('agent-launch-strip')
    await expect(strip).toBeVisible()
    await expect(strip).toContainText('A sub-agent never reported back')

    // The legacy live channel cleared. Native inspection is still advertised
    // by this fixture, so only its neutral history entry remains, not activity.
    await expect(page.getByTestId('subagent-chip')).toHaveText('Subagents')
    await expect(page.getByTestId('background-work-indicator')).toHaveCount(0)
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('currentStep')
  } finally {
    await shutdown(harness)
  }
})

test('Subagents settings follow package availability and fit both themes', async () => {
  const soloAgentDir = privateAgentDir()
  const harness = await launch({ agentDir: soloAgentDir })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.keyboard.press('ControlOrMeta+Comma')
    await expect(page.getByRole('button', { name: 'Subagents', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close settings' }).click()
    const dir = join(soloAgentDir, 'npm', 'node_modules', 'pi-subagents')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'pi-subagents', version: '0.76.1' }),
    )
    await writeFile(
      join(soloAgentDir, 'settings.json'),
      JSON.stringify({ packages: ['npm:pi-subagents'] }),
    )
    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('button', { name: 'Subagents', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(settings).toContainText('Pi owns execution')
    await expect(settings.getByRole('button', { name: 'Edit global settings…' })).toBeVisible()
    await harness.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(760, 850),
    )
    for (const theme of ['dark', 'light']) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
        theme,
      )
      await expect(settings.getByRole('button', { name: 'Subagents', exact: true })).toHaveCSS(
        'color',
        theme === 'dark' ? 'rgb(236, 231, 219)' : 'rgb(38, 38, 42)',
      )
      expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      )
      await page.screenshot({ path: test.info().outputPath(`subagents-settings-${theme}.png`) })
    }
    await page.getByRole('button', { name: 'Close settings' }).click()
    await writeFile(join(soloAgentDir, 'settings.json'), JSON.stringify({ packages: [] }))
    await page.keyboard.press('ControlOrMeta+Comma')
    await expect(page.getByRole('button', { name: 'Subagents', exact: true })).toHaveCount(0)
    await expect(settings.getByRole('heading', { name: 'Extensions', exact: true })).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('a parallel delegation shows every child working at once, then settles', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    // The stub holds a four-child `parallel` call mid-run: the scout has
    // reported, three children are each on a different tool.
    await page
      .getByPlaceholder('Describe a task or ask a question')
      .fill('Fix the token refresh bug, split the work in parallel')
    await page.getByRole('button', { name: /Start session/i }).click()

    const row = page.getByRole('button', { name: /Running workflow/ })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row).toContainText('scout · worker · researcher')
    await expect(row).toContainText('1/4 done')
    // One call, four agents: the group line counts agents, not calls.
    await expect(page.getByTestId('activity-summary').first()).toContainText('delegated 4 agents')
    await row.click()

    const children = page.getByTestId('subagent-child')
    await expect(children).toHaveCount(4)
    for (const [i, status] of ['completed', 'running', 'running', 'running'].entries()) {
      await expect(children.nth(i)).toHaveAttribute('data-status', status)
    }
    await expect(children.nth(0)).toContainText('7 callers in 4 files')
    await expect(page.getByTestId('subagent-current-tool')).toHaveText([
      '⎿ edit src/auth/session.ts',
      '⎿ bash npm test -- src/auth',
      '⎿ fetch_content rfc-editor.org/rfc/rfc9700',
    ])
    // The parent turn is still running while its children work.
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    await expect(page.getByTestId('session-row').first()).toBeVisible()
    const current = page.getByTestId('background-work-indicator')
    await expect(current.getByTestId('current-work-headline')).toHaveText(
      '3 agents working · parent working',
    )
    await expect(page.getByRole('button', { name: 'Subagents pane', exact: true })).toBeVisible()
    await expect(page.locator('[data-tooltip="3 subagents active"]')).toHaveText('3')
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByPlaceholder('Type a command…').fill('Toggle artifacts pane')
    await page.getByText('Toggle artifacts pane', { exact: true }).click()
    await expect(current).toBeInViewport()
    await current.getByRole('button', { name: 'Expand current work' }).click()
    await current
      .getByRole('button', { name: /^4 delegated tasks · scout, worker, researcher: running/ })
      .click()
    const inspection = page.getByRole('region', { name: 'Subagents', exact: true })
    await expect(inspection.getByRole('heading', { name: '4 delegated tasks' })).toBeVisible()
    await expect(inspection.getByTestId('subagent-child')).toHaveCount(4)
    await expect(inspection).toContainText('bash npm test -- src/auth')
    await page.screenshot({ path: test.info().outputPath('subagents-parallel.png') })
    await inspection.getByRole('button', { name: 'Close pane', exact: true }).click()

    const finished = await page.evaluate(async () => {
      const live = await window.phosphor.invoke('pi:listLiveSessions')
      if (live.length !== 1) throw new Error('Expected one isolated stub session')
      return window.phosphor.piCommand(live[0]!.sessionId, {
        type: 'prompt',
        message: '/stub-finish-parallel',
      })
    })
    expect(finished.success).toBe(true)
    await expect(
      page.getByText('All four reported. Refresh now lives in session.ts and the auth tests pass.'),
    ).toBeVisible({ timeout: 30_000 })
    const summary = page.getByTestId('activity-summary').first()
    if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click()
    await expect(page.getByRole('button', { name: /Ran workflow/ })).toContainText('4 agents')
  } finally {
    await shutdown(harness)
  }
})

test('the home workbench keeps parallel lanes visible and reuses subagent inspection', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('queue-hold')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^New$/ }).click()
    const board = page.getByRole('region', { name: 'Lane workbench' })
    const cards = board.getByTestId('lane-board-card')
    await expect(cards).toHaveCount(1)
    await expect(page.getByText(/Start your first session/)).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Your workbench' })).toBeVisible()
    await page.getByRole('button', { name: 'New lane', exact: true }).click()
    await expect(page.getByPlaceholder('Describe a task or ask a question')).toBeFocused()
    await page.getByPlaceholder('Describe a task or ask a question').fill('delegate please')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByTestId('subagent-chip')).toContainText('1 background run active', {
      timeout: 60_000,
    })
    await page.getByRole('button', { name: /^New$/ }).click()
    await expect(cards).toHaveCount(2)
    const delegated = cards.filter({ hasText: 'scout' })
    await expect(delegated).toContainText('delegated work in progress')
    await expect(delegated).toContainText('grep')
    await delegated.getByRole('button', { name: 'View subagents' }).click()
    const inspector = page.getByRole('region', { name: 'Subagents', exact: true })
    await expect(inspector).toBeVisible()
    await expect(board).toBeHidden()
    await inspector
      .getByRole('button', { name: 'Map the auth flow · scout: running · grep' })
      .click()
    await expect(inspector).toContainText('Inspection: following login.ts to verify.ts.')
    await inspector.getByRole('button', { name: 'Close pane', exact: true }).click()
    await page.getByRole('button', { name: /^New$/ }).click()
    await expect(cards).toHaveCount(2)
    for (const width of [1200, 760]) {
      await harness.app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error('Expected the app window')
        window.setMinimumSize(640, 600)
        window.setSize(width, 900)
      }, width)
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
          theme,
        )
        expect(await board.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        )
        await expect(page.getByRole('button', { name: /Start session/i })).toBeVisible()
        await page.screenshot({
          path: test.info().outputPath(`workbench-${width}-${theme}.png`),
          animations: 'disabled',
        })
      }
    }
    const held = cards.filter({ hasNotText: 'scout' })
    await held.getByRole('button', { name: 'Open lane' }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await page.getByRole('button', { name: /^New$/ }).click()
    await expect(cards).toHaveCount(2)
    await expect(held).toContainText('Idle')
  } finally {
    await shutdown(harness)
  }
})

test('a native delegation is an agent row with live progress, a fleet chip and a completion card', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    // The stub replays pi-subagents over RPC: a foreground reviewer that
    // streams progress and settles, a scout detached into the background, the
    // background tree on the `subagent-async` widget, and the completion
    // message that wakes the model.
    await page.getByPlaceholder('Describe a task or ask a question').fill('delegate please')
    await page.getByRole('button', { name: /Start session/i }).click()

    // While the reviewer runs, its row says who, and what it is on right now.
    await expect(page.getByText('Delegating to')).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId('transcript-scroll').getByText('read src/auth.ts · 3 tools'),
    ).toBeVisible()
    // The summary above the composer shows the same live step without expanding.
    await expect(page.getByTestId('current-work-ticker')).toHaveText(
      'Review the auth diff for regressions · read src/auth.ts · 3 tools',
    )

    await expect(
      page.getByText('Reviewer found one nit; scout is mapping the auth flow in the background.'),
    ).toBeVisible({ timeout: 60_000 })

    // The background run is a chip, not a JSON blob above the composer.
    const chip = page.getByTestId('subagent-chip')
    await expect(chip).toContainText('1 background run active · scout · grep')
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(
      'PI_SUBAGENT_ASYNC_JSON',
    )

    const background = page.getByTestId('background-work-indicator')
    await expect(background.getByTestId('current-work-headline')).toHaveText(
      '1 agent working · parent idle',
    )
    // Parent turns are visible but not announced; agent counts are.
    await expect(background.getByRole('status')).toHaveText('1 agent working')
    await expect(background.getByRole('button', { name: 'Expand current work' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(
      background.getByRole('button', { name: 'Map the auth flow · scout: running · grep' }),
    ).toBeHidden()
    // Collapsed, one line still says who is working and on what.
    await expect(background.getByTestId('current-work-ticker')).toHaveText(
      'Map the auth flow · grep · 2 tools',
    )
    await expect(page.getByTestId('working-indicator')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await background.getByRole('button', { name: 'View subagents' }).click()
    const inspector = page.getByRole('region', { name: 'Subagents', exact: true })
    await expect(inspector).toBeVisible()
    // A single-agent run is one row, not a run plus its step.
    await expect(inspector.getByRole('button', { name: /· scout: / })).toHaveCount(1)
    await inspector
      .getByRole('button', { name: 'Map the auth flow · scout: running · grep' })
      .click()
    await expect(inspector.getByRole('heading', { name: 'Map the auth flow' })).toBeVisible()
    await expect(inspector.getByRole('region', { name: 'Live activity' })).toContainText('grep')
    await inspector.getByText('Details & actions', { exact: true }).click()
    await inspector.getByRole('button', { name: 'Stop run…' }).click()
    await expect(inspector).toContainText('stopped runs cannot resume')
    await inspector.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(inspector).toContainText('Inspection: following login.ts to verify.ts.')
    await expect(inspector).toContainText('Older activity was left out of this read.')
    expect(await inspector.innerText()).not.toContain('PI_SUBAGENT_INSPECT_JSON')
    await page.screenshot({ path: test.info().outputPath('subagents-inspector.png') })
    await inspector.getByRole('button', { name: 'Close pane', exact: true }).click()

    // Settled: one row per call, in pi's vocabulary, with what it cost.
    const summary = page.getByTestId('activity-summary').first()
    await expect(summary).toContainText(/delegated 2 agents/)
    await summary.click()
    const reviewer = page.getByRole('button', { name: /Delegated to reviewer/ })
    await expect(reviewer).toContainText('4 tools · 4.0k tokens · 9.1s')
    await expect(page.getByRole('button', { name: /Started scout/ })).toContainText('in background')

    // The row opens onto the task and the child's answer.
    await reviewer.click()
    await expect(page.getByTestId('subagent-task')).toContainText('Review the auth diff')
    const childCard = page.getByTestId('subagent-child')
    await expect(childCard).toHaveAttribute('data-status', 'completed')
    await expect(childCard).toContainText('No regressions found')
    await expect(childCard.getByTestId('subagent-output')).not.toHaveAttribute('open', '')
    await expect(page.getByTestId('subagent-supervisor-output')).toContainText(
      'Output received by parent',
    )
    await expect(page.getByTestId('subagent-supervisor-output')).toContainText(
      'No regressions found',
    )
    await page.getByRole('button', { name: /Started scout/ }).click()
    await expect(page.getByTestId('subagent-async-note')).toContainText(
      'Launched in the background',
    )

    // Complete the mock child only after live inspection. A wall-clock delay
    // races the inspector on slower CI runners and drops its selected row.
    const completion = await page.evaluate(async () => {
      const live = await window.phosphor.invoke('pi:listLiveSessions')
      if (live.length !== 1) throw new Error('Expected one isolated stub session')
      return window.phosphor.piCommand(live[0]!.sessionId, {
        type: 'prompt',
        message: '/stub-finish-delegation',
      })
    })
    expect(completion.success).toBe(true)

    // The run reports back: one folded line where the model woke up, with a
    // link straight to its run. The chip remains as an entry to recorded history.
    const notice = page.getByTestId('subagent-notice')
    await expect(notice).toContainText('scout finished in the background', { timeout: 30_000 })
    await expect(page.getByTestId('subagent-notice-body')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('subagent-notice-folded.png') })
    await notice.getByRole('button', { name: 'Inspect run' }).click()
    await expect(inspector.getByRole('heading', { name: 'Map the auth flow' })).toBeVisible()
    await expect(page.getByTestId('subagent-notice-body')).toHaveCount(0)
    await inspector.getByRole('button', { name: 'Close pane', exact: true }).click()
    await notice.getByRole('button', { name: /scout finished in the background/ }).click()
    await expect(page.getByTestId('subagent-notice-body')).toContainText('login.ts')
    await expect(page.getByText('Scout reports: the auth flow enters at login.ts.')).toBeVisible()
    await expect(chip).toHaveText('Subagents')
    await expect(background.getByTestId('current-work-headline')).toHaveText(
      'No agents working · parent idle',
    )
    await expect(background).toContainText('Recent')
    await expect(background).not.toContainText('status unavailable')
    await chip.click()
    await inspector.getByRole('button', { name: 'Coordination log' }).click()
    await expect(inspector).toContainText('worker asked the parent for guidance')
    await expect(inspector).toContainText('parent replied')
    await inspector
      .getByRole('button', { name: /worker asked the parent for guidance.*parent replied/ })
      .click()
    await expect(inspector).toContainText('Use the shared parser.')
    await page.screenshot({ path: test.info().outputPath('subagents-coordination.png') })
    await inspector.getByRole('button', { name: 'Close pane', exact: true }).click()
  } finally {
    await shutdown(harness)
  }
})

test('recorded workflow completions and attention stay visible, attributable and inspectable', async () => {
  const commands = join(await scratchDir('phosphor-subagent-commands-'), 'commands.jsonl')
  const harness = await launch({ env: { PHOSPHOR_E2E_COMMAND_LOG: commands } })
  const { page } = harness
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const screenshot = async (name: string): Promise<void> => {
    const path = test.info().outputPath(`${name}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await test.info().attach(name, { path, contentType: 'image/png' })
  }
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('workflow-evidence')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(
      page.getByText('Reviewer reported; validation and QA continue independently.'),
    ).toBeVisible()
    const notices = page.getByTestId('subagent-notice')
    await expect(notices).toHaveCount(2)
    // Every notice starts as one line; its signal and diagnostics open together.
    await expect(notices.nth(0)).toContainText('reviewer completed a workflow step')
    await expect(notices.nth(1)).toContainText('validation · worker needs parent attention')
    await expect(notices.nth(1)).not.toContainText('Elapsed time alone does not prove a stall')
    await expect(page.getByTestId('subagent-notice-body')).toHaveCount(0)
    await expect(page.getByTestId('subagent-chip')).toContainText('1 background run active')
    const background = page.getByTestId('background-work-indicator')
    await expect(background.getByTestId('current-work-headline')).toHaveText(
      '2 agents working · 1 needs parent attention · parent idle',
    )
    const expandWork = background.getByRole('button', { name: 'Expand current work' })
    await expect(expandWork).toHaveAttribute('aria-expanded', 'false')
    await expect(background.getByRole('button', { name: 'qa: running' })).toBeHidden()
    const compactHeight = (await background.boundingBox())!.height
    await expandWork.focus()
    await page.keyboard.press('Enter')
    await expect(background.getByRole('button', { name: 'qa: running' })).toBeVisible()
    expect((await background.boundingBox())!.height).toBeGreaterThan(compactHeight + 40)
    await page.keyboard.press('Space')
    await expect(expandWork).toBeFocused()
    await expect(expandWork).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Tab')
    await expect(background.getByRole('button', { name: 'View subagents' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(background.locator(':focus')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByPlaceholder('Type a command…').fill('Toggle artifacts pane')
    await page.getByText('Toggle artifacts pane', { exact: true }).click()
    await expect(background).toBeInViewport()
    for (const [message, expected] of [
      ['/stub-hide-workflow-status', '2 agents · status unavailable'],
      ['/stub-restore-workflow-status', '2 agents working'],
    ]) {
      const response = await page.evaluate(async (message) => {
        const live = await window.phosphor.invoke('pi:listLiveSessions')
        return window.phosphor.piCommand(live[0]!.sessionId, { type: 'prompt', message })
      }, message!)
      expect(response.success).toBe(true)
      await expect(background.getByRole('status')).toContainText(expected!)
      await expect(background).toBeInViewport()
      await expect(expandWork).toHaveAttribute('aria-expanded', 'false')
      if (message === '/stub-hide-workflow-status') {
        expect((await background.boundingBox())!.height).toBeLessThan(130)
        await screenshot('current-work-unavailable-compact')
      }
    }
    await expandWork.click()
    await background
      .getByRole('button', { name: 'validation: running · needs parent attention', exact: true })
      .click()
    const direct = page.getByRole('region', { name: 'Subagents', exact: true })
    await expect(direct).toContainText('child validation')
    await direct.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(background.getByTestId('current-work-headline')).toContainText('parent idle')
    await expect(page.getByTestId('working-indicator')).toHaveCount(0)
    const sidebarWorking = page.getByTestId('session-row').getByText('Working', { exact: true })
    await expect(sidebarWorking).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await page.getByPlaceholder('Describe a task…', { exact: false }).fill('Draft for the parent')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()

    // Real captured notices and an extension-projected three-child tree, not
    // just the previous single-scout happy path. Inspector replies below are scripted.
    for (const width of [1440, 900]) {
      await harness.app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
        width,
      )
      for (const theme of ['dark', 'light']) {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page
          .getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
          .click()
        await page.getByRole('button', { name: 'Close settings' }).click()
        await expect(page.locator('aside').first()).toHaveCSS(
          'background-color',
          theme === 'dark' ? 'rgb(21, 19, 15)' : 'rgb(237, 237, 239)',
        )
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true)
        await expect(background).toBeInViewport()
        expect(await background.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        await screenshot(`workflow-notices-${theme}-${width}`)
        await notices.nth(0).getByRole('button', { name: 'Inspect run' }).click()
        const panel = page.getByRole('region', { name: 'Subagents', exact: true })
        await panel.getByRole('button', { name: 'Fullscreen pane', exact: true }).click()
        await expect(panel).toContainText('CHANGES_REQUESTED')
        await expect(panel).toContainText('Run 10000001-0000-4000-8000-000000000000')
        if (width < 1000) await panel.getByRole('button', { name: 'Back to runs' }).click()
        await expect(
          panel.getByRole('button', { name: 'reviewer: complete', exact: true }),
        ).toBeVisible()
        await expect(panel.getByRole('button', { name: 'qa: running', exact: true })).toBeVisible()
        // A notice's child is not an advertised root Stop target.
        await expect(panel.getByRole('button', { name: 'Stop run…' })).toHaveCount(0)
        expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        await screenshot(`workflow-inspector-${theme}-${width}`)
        await panel.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
        await panel.getByRole('button', { name: 'Close pane', exact: true }).click()
      }
    }
    await notices.nth(1).getByRole('button', { name: 'Inspect run' }).click()
    const panel = page.getByRole('region', { name: 'Subagents', exact: true })
    await expect(panel).toContainText('The previous bash command has finished')
    await panel.getByRole('button', { name: 'Coordination log' }).click()
    await expect(panel.getByTestId('subagent-notice')).toHaveCount(2)
    await expect(panel.getByTestId('subagent-notice').first()).toContainText(
      'needs parent attention',
    )
    await panel
      .getByTestId('subagent-notice')
      .filter({ hasText: 'reviewer completed a workflow step' })
      .getByRole('button', { name: 'Inspect run' })
      .click()
    await expect(panel).toContainText('CHANGES_REQUESTED')
    const output = panel.getByRole('region', { name: 'Agent output' })
    await expect(output.getByText(/^CHANGES_REQUESTED:/)).toBeVisible()
    // This historical fixture uses the UI-only `custom` role, not `customMessage`.
    await expect(output).toContainText("From the agent's record")
    await expect(output).not.toContainText('Parent was notified')
    await panel.getByRole('button', { name: 'Close pane', exact: true }).click()
    // The full original diagnostic remains available, but does not bury chat.
    await notices
      .nth(1)
      .getByRole('button', { name: /validation · worker/ })
      .click()
    const attention = notices.nth(1).getByTestId('subagent-notice-body')
    await expect(attention).toContainText('Elapsed time alone does not prove a stall')
    await expect(attention).toContainText('command.cancel')
    await notices
      .nth(0)
      .getByRole('button', { name: /reviewer completed a workflow step/ })
      .click()
    await expect(notices.nth(0)).toContainText('Workflow was still running at this update')
    // The in-lane entry opens the same native inspector, with exact root + step identity.
    await background.getByRole('button', { name: 'View subagents' }).click()
    await panel.getByRole('button', { name: 'Back to runs' }).click()
    await panel.getByRole('button', { name: /^validation: running/ }).click()
    await expect(panel).toContainText('Validation: full suite is running')
    const settled = await page.evaluate(async () => {
      const live = await window.phosphor.invoke('pi:listLiveSessions')
      if (live.length !== 1) throw new Error('Expected one isolated stub session')
      return window.phosphor.piCommand(live[0]!.sessionId, {
        type: 'prompt',
        message: '/stub-settle-workflow',
      })
    })
    expect(settled.success).toBe(true)
    await expect(background.getByTestId('current-work-headline')).toHaveText(
      'No agents working · parent idle',
    )
    await expect(background).toContainText('Recent')
    await expect(sidebarWorking).toHaveCount(0)
    // Live completion does not dismiss an inspection or rewrite historical warnings.
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(notices.nth(1)).toContainText('validation · worker needs parent attention')
    await expect(page.getByPlaceholder('Describe a task…', { exact: false })).toHaveValue(
      'Draft for the parent',
    )
    await page.reload()
    await expect(background).toHaveCount(0)
    await expect(page.getByTestId('subagent-notice')).toHaveCount(2)
    await expect(page.getByTestId('subagent-notice').first()).toContainText('reviewer completed')
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('PI_SUBAGENT_')
    const sent = (await readFile(commands, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const inspected = sent.filter(
      (c) => c.type === 'prompt' && c.message.startsWith('/subagents-inspect-rpc '),
    )
    expect(inspected.length).toBeGreaterThanOrEqual(7)
    expect(
      inspected.some((c) =>
        /^\/subagents-inspect-rpc [\w-]+ 10000000-0000-4000-8000-000000000000 validation --lines 100$/.test(
          c.message,
        ),
      ),
    ).toBe(true)
    // Restoring selection and refreshing a settled target can repeat reads,
    // but may never change their exact run/child identities.
    expect(
      inspected.every((c) =>
        /^\/subagents-inspect-rpc [\w-]+ (?:1000000[12]-0000-4000-8000-000000000000|10000000-0000-4000-8000-000000000000 validation) --lines 100$/.test(
          c.message,
        ),
      ),
    ).toBe(true)
    expect(sent.some((c) => c.type === 'prompt' && c.message.startsWith('/subagents-stop'))).toBe(
      false,
    )
    expect(errors).toEqual([])
  } finally {
    await shutdown(harness)
  }
})

test('subagent inspection, steering and saved snapshots survive compaction and a full restart', async () => {
  const userDataDir = await scratchDir('phosphor-subagent-save-')
  const commands = join(userDataDir, 'commands.jsonl')
  const first = await launch({ userDataDir, env: { PHOSPHOR_E2E_COMMAND_LOG: commands } })
  const { workspace, page } = first
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('workflow-evidence')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByTestId('background-work-indicator')).toBeVisible()
    await page.getByRole('button', { name: 'View subagents' }).click()
    const panel = page.getByRole('region', { name: 'Subagents', exact: true })
    await panel.getByRole('button', { name: /^validation: running/ }).click()
    await expect(panel).toContainText('Validation: full suite is running')
    for (const width of [1440, 900]) {
      await first.app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
        width,
      )
      for (const theme of ['dark', 'light']) {
        await panel.getByRole('button', { name: 'Close pane', exact: true }).click()
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page
          .getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
          .click()
        await page.getByRole('button', { name: 'Close settings' }).click()
        await page.getByTestId('subagent-chip').click()
        await expect(panel).toContainText('child validation')
        await panel.getByText('Details & actions', { exact: true }).click()
        await panel.getByRole('button', { name: 'Steer…' }).click()
        await panel
          .getByLabel('Steering message', { exact: true })
          .fill('Check the focused parser tests.')
        expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({
          path: test.info().outputPath(`subagent-steer-${theme}-${width}.png`),
          animations: 'disabled',
        })
      }
    }
    await panel.getByRole('button', { name: 'Send steering message' }).click()
    await expect(panel).toContainText('Steering requested')
    await panel.getByRole('button', { name: 'Save snapshot', exact: true }).click()
    await expect(panel).toContainText('Saved in Artifacts')
    // Saving alone never takes the pane or closes the inspection.
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('artifact-scroll')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('subagent-saved-and-steered.png') })
    await panel.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(
      page.getByTestId('subagent-notice').filter({ hasText: 'Steering delivered' }),
    ).toHaveCount(1)
    await expect(page.getByText('Running subagent...', { exact: true })).toHaveCount(0)
    await page.getByTestId('subagent-chip').click()
    await expect(panel).toContainText('Validation: full suite is running')
    expect(
      (
        await page.evaluate(async () => {
          const live = await window.phosphor.invoke('pi:listLiveSessions')
          return window.phosphor.piCommand(live[0]!.sessionId, {
            type: 'prompt',
            message: '/stub-expire-and-compact-workflow',
          })
        })
      ).success,
    ).toBe(true)
    await expect(panel).toContainText('Native inspection artifacts expired')
    await expect(panel).toContainText('last successful read')
    await expect(page.getByTestId('background-work-indicator')).toContainText('Recent')
    await expect(page.getByTestId('background-work-indicator')).toContainText('No agents working')
    await expect(panel.getByRole('button', { name: 'Stop run…' })).toHaveCount(0)
  } finally {
    await first.app.close()
  }

  const second = await launch({
    workspace,
    userDataDir,
    env: { PHOSPHOR_E2E_COMMAND_LOG: commands },
  })
  try {
    const p = second.page
    await expect(p.getByTestId('session-row')).toHaveCount(1, { timeout: 30_000 })
    await p.getByTestId('session-row').click()
    await expect(p.getByTestId('subagent-chip')).toBeVisible()
    // Pane layout can restore, but never restores old liveness.
    await expect(p.getByRole('dialog', { name: 'Subagents', exact: true })).toHaveCount(0)
    await expect(p.getByTestId('background-work-indicator')).toHaveCount(0)
    await p.getByTestId('subagent-chip').click()
    const panel = p.getByRole('region', { name: 'Subagents', exact: true })
    await expect(panel).toContainText('child validation')
    await expect(panel).toContainText('Native inspection artifacts expired')
    await panel.getByRole('button', { name: 'Coordination log' }).click()
    await expect(panel).toContainText('reviewer completed a workflow step')
    await expect(panel).toContainText('Steering delivered to the addressed child')
    await panel.getByRole('button', { name: 'Close pane', exact: true }).click()
    await p.getByRole('button', { name: 'Artifacts pane', exact: true }).click()
    await expect(p.getByTestId('right-pane')).toContainText('Saved subagent snapshot')
    await expect(p.getByTestId('artifact-scroll')).toContainText(
      'Validation: full suite is running',
    )
    await expect(p.getByTestId('artifact-scroll')).toContainText('content was omitted')
    await p.screenshot({ path: test.info().outputPath('subagent-snapshot-after-restart.png') })
    const sent = (await readFile(commands, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      sent
        .filter((c) => c.type === 'prompt' && c.message.startsWith('/subagents-steer '))
        .map((c) => c.message),
    ).toEqual([
      '/subagents-steer 10000000-0000-4000-8000-000000000000 --child validation Check the focused parser tests.',
    ])
    expect(
      sent.filter((c) => c.type === 'prompt' && !c.message.startsWith('/')).map((c) => c.message),
    ).toEqual(['workflow-evidence'])
  } finally {
    await shutdown(second)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('subagent pane owns scrolling, keeps rows stable and preserves drafts across docking', async () => {
  const harness = await launch({ env: { PHOSPHOR_E2E_SUBAGENT_LAYOUT: '1' } })
  const { page, app } = harness
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('workflow-evidence')
    await page.getByRole('button', { name: /Start session/i }).click()
    await page.getByRole('button', { name: 'View subagents' }).click()
    const pane = page.getByRole('region', { name: 'Subagents', exact: true })
    await pane.getByRole('button', { name: 'Fullscreen pane' }).click()
    const nav = pane.getByRole('navigation', { name: 'Agent runs' })
    const row = nav.getByRole('button', { name: /^validation: running/ })
    await row.click()
    const transcript = pane.getByTestId('subagent-transcript')
    await expect(transcript.getByRole('region', { name: 'Agent input' })).toBeVisible()
    await expect(
      transcript.getByRole('heading', { name: 'Validate module boundaries' }),
    ).toBeVisible()
    await expect(transcript.getByTestId('subagent-activity')).not.toHaveAttribute('open', '')
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0)
    await page.screenshot({ path: test.info().outputPath('subagent-handoff-overview.png') })
    await transcript.getByTestId('subagent-activity').locator('summary').first().click()
    await transcript
      .getByTestId('subagent-activity-record')
      .filter({ hasText: 'Inspecting module 39' })
      .locator('summary')
      .click()
    await expect(transcript.getByRole('heading', { name: 'Inspecting module 39' })).toBeVisible()
    const header = pane.getByRole('heading', { name: 'validation', exact: true })
    const before = {
      row: await row.boundingBox(),
      header: await header.boundingBox(),
      navScroll: await nav.evaluate((el) => el.scrollTop),
    }
    await transcript.hover()
    await page.mouse.wheel(0, -10000)
    // The wheel scroll is asynchronous (notably on Linux): wait for it to land.
    await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0)
    await transcript.evaluate((el) => {
      el.scrollTop = 100
    })
    await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(100)
    expect(await row.boundingBox()).toEqual(before.row)
    expect(await header.boundingBox()).toEqual(before.header)
    expect(await nav.evaluate((el) => el.scrollTop)).toBe(before.navScroll)
    // Independent list overflow never scrolls the transcript or the pane header.
    await nav.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(100)
    await nav.evaluate((el, top) => {
      el.scrollTop = top
    }, before.navScroll)
    await page.evaluate(async () => {
      const [live] = await window.phosphor.invoke('pi:listLiveSessions')
      await window.phosphor.piCommand(live!.sessionId, {
        type: 'prompt',
        message: '/stub-subagent-layout-update',
      })
    })
    await expect(row).toContainText('100 tools')
    expect((await row.boundingBox())!.height).toBe(before.row!.height)
    expect((await row.boundingBox())!.y).toBe(before.row!.y)
    await pane.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(pane.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(100)
    await pane.getByText('Details & actions', { exact: true }).click()
    await pane.getByRole('button', { name: 'Steer…' }).click()
    const draft = pane.getByLabel('Steering message', { exact: true })
    await draft.fill('Keep this unsent draft across pane moves')
    await pane.getByRole('button', { name: 'Exit fullscreen' }).click()
    await expect(draft).toHaveValue('Keep this unsent draft across pane moves')
    await pane.getByRole('button', { name: 'Move pane to the left' }).click()
    await expect(draft).toHaveValue('Keep this unsent draft across pane moves')
    await pane.getByRole('button', { name: 'Move pane to the right' }).click()
    await pane.getByRole('button', { name: 'Fullscreen pane' }).click()
    await expect(draft).toHaveValue('Keep this unsent draft across pane moves')
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(100)
    await pane.getByText('Details & actions', { exact: true }).click()
    for (const theme of ['dark', 'light']) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page
        .getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
        .click()
      await page.getByRole('button', { name: 'Close settings' }).click()
      await page.screenshot({ path: test.info().outputPath(`subagent-pane-${theme}.png`) })
    }
    // Pane-width responsive navigation, even inside a wide application window.
    await pane.getByRole('button', { name: 'Exit fullscreen' }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 800))
    await expect(nav).not.toBeVisible()
    await pane.getByRole('button', { name: 'Back to runs' }).click()
    await expect(row).toBeFocused()
    await row.press('Enter')
    await expect(header).toBeFocused()
    expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.25),
    )
    expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    // The summary beside a docked pane truncates its text, never its button.
    const summary = page.getByTestId('background-work-indicator')
    const summaryBox = (await summary.boundingBox())!
    const viewBox = (await summary.getByRole('button', { name: 'View subagents' }).boundingBox())!
    expect(viewBox.x + viewBox.width).toBeLessThanOrEqual(summaryBox.x + summaryBox.width)
    const bounds = (await pane.boundingBox())!
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage())
        .toPNG()
        .toString('base64'),
    )
    await writeFile(
      test.info().outputPath('subagent-pane-narrow-zoom.png'),
      Buffer.from(png, 'base64'),
    )
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
    )
    await pane.getByText('Details & actions', { exact: true }).click()
    await pane.getByRole('button', { name: 'Save snapshot', exact: true }).click()
    await expect(pane).toContainText('Saved in Artifacts')
    await pane.getByRole('button', { name: 'View saved snapshot' }).click()
    await expect(pane).toHaveCount(0)
    await expect(page.getByTestId('artifact-scroll')).toContainText('Inspecting module 39')
    expect(errors).toEqual([])
  } finally {
    await shutdown(harness)
  }
})

test('the updater stays dormant in an unpackaged run', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)

    // The updater is gated on app.isPackaged. E2E and dev runs are unpackaged,
    // so it must report `unsupported` and never reach the network — otherwise
    // every test run (and every `npm run dev`) would poll GitHub releases.
    const state = await page.evaluate(() => window.phosphor.invoke('updates:state'))
    expect(state.phase).toBe('unsupported')

    // An explicit check is likewise a no-op rather than a fetch.
    await page.evaluate(() => window.phosphor.invoke('updates:check'))
    expect((await page.evaluate(() => window.phosphor.invoke('updates:state'))).phase).toBe(
      'unsupported',
    )

    // And with nothing to install, the pill never renders.
    await expect(page.getByTestId('update-pill')).toHaveCount(0)
  } finally {
    await shutdown(harness)
  }
})

test('feedback is reachable from the Settings footer and never nags a fresh install', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    // It lives in the Settings footer, not the sidebar.
    await expect(page.getByTestId('feedback-button')).toHaveCount(0)
    await page.getByRole('button', { name: 'Settings' }).click()

    // A first-run profile has one launch and no history, so the row is the
    // quiet variant: findable, no dot, no dismiss, no popup anywhere.
    const button = page.getByTestId('feedback-button')
    await expect(button).toHaveAttribute('data-nudge', 'false')
    await expect(button).toContainText('Send feedback')
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0)

    await button.click()
    const submit = page.getByRole('button', { name: 'Open on GitHub' })
    // A rating on its own says nothing, so submit stays shut until there is a
    // sentence to go with it.
    await expect(submit).toBeDisabled()

    // Without a relay the app cannot post anonymously, and says so rather than
    // offering a checkbox it could not honour.
    await expect(page.getByRole('checkbox', { name: /Send anonymously/ })).toBeDisabled()

    await page.getByPlaceholder('The good and the bad').fill('Lanes are the best part.')
    await expect(submit).toBeEnabled()

    // Not clicked: submitting here would open a real browser. The submit path
    // itself is covered in electron/feedback/feedback-service.test.ts.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(submit).toHaveCount(0)
  } finally {
    await shutdown(harness)
  }
})

test('extensions tab lists pi packages and reveals per-extension tabs', async () => {
  // A dir of this test's own: the fixture below is a hand-written
  // `node_modules` entry, and any real `npm install` into a shared agent dir
  // prunes it (see `privateAgentDir`).
  const soloAgentDir = privateAgentDir()
  // Seed it: one installed fixture package plus the Claude provider declared
  // in settings (declared is enough to reveal its tab — installed-ness only
  // changes the health row).
  const pkgDir = join(soloAgentDir, 'npm', 'node_modules', 'demo-pack')
  await mkdir(join(pkgDir, 'extensions'), { recursive: true })
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'demo-pack',
      version: '1.2.3',
      description: 'Fixture package for the extensions tab',
      pi: { extensions: ['extensions/main.ts'] },
    }),
  )
  await writeFile(join(pkgDir, 'extensions', 'main.ts'), '')
  await writeFile(
    join(soloAgentDir, 'settings.json'),
    JSON.stringify({ packages: ['npm:demo-pack', 'npm:@saccolabs/pi-claude-cli'] }),
  )

  const harness = await launch({ agentDir: soloAgentDir })
  try {
    await openWorkspace(harness.page)
    const page = harness.page

    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('button', { name: 'Extensions', exact: true }).click()

    // The installed fixture resolves against the real install-dir layout.
    await expect(page.getByText('demo-pack', { exact: true })).toBeVisible()
    await expect(page.getByText('v1.2.3')).toBeVisible()
    await expect(page.getByText('npm:demo-pack', { exact: true })).toBeVisible()
    // Contents are listed by name, resolved from the manifest.
    await expect(page.getByText('Extensions (1)')).toBeVisible()
    await expect(page.getByText('main.ts', { exact: true })).toBeVisible()
    // The declared-but-absent package is reported, not hidden.
    await expect(page.getByText('installs on next session start')).toBeVisible()

    // Presence of pi-claude-cli in packages reveals its dedicated tab.
    await page.getByRole('button', { name: 'Claude Code', exact: true }).click()
    await expect(page.getByText('Claude Code provider')).toBeVisible()
    await expect(page.getByText('Extension package')).toBeVisible()
  } finally {
    await shutdown(harness)
    // Nothing to leave as found — the whole dir was this test's.
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('extensions tab installs and removes a package through pi CLI (stubbed)', async () => {
  const soloAgentDir = privateAgentDir()
  const harness = await launch({ agentDir: soloAgentDir })
  try {
    await openWorkspace(harness.page)
    const page = harness.page

    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('button', { name: 'Extensions', exact: true }).click()

    // Install by spec: the job shells to the (stubbed) pi package manager,
    // streams its output, and the listing refreshes on exit.
    await page.getByPlaceholder(/npm:pkg/).fill('npm:e2e-added-pack')
    await page.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(page.getByText('Installed npm:e2e-added-pack')).toBeVisible()
    await expect(page.getByText('e2e-added-pack', { exact: true })).toBeVisible()
    await expect(page.getByText('v9.9.9-stub')).toBeVisible()

    // Remove round-trips the same way.
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByText('Removed npm:e2e-added-pack')).toBeVisible()
    await expect(page.getByText('e2e-added-pack', { exact: true })).toHaveCount(0)
  } finally {
    await shutdown(harness)
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('web access tab writes provider keys to web-search.json', async () => {
  const soloAgentDir = privateAgentDir()
  await writeFile(
    join(soloAgentDir, 'settings.json'),
    JSON.stringify({ packages: ['npm:pi-web-access'] }),
  )
  const harness = await launch({ agentDir: soloAgentDir })
  try {
    await openWorkspace(harness.page)
    const page = harness.page

    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('button', { name: 'Web access', exact: true }).click()

    // Set the first provider row (Brave). Commit on Enter.
    await page.getByRole('button', { name: 'Set key' }).first().click()
    await page.getByPlaceholder('BSA_…').fill('BSA_e2e_123')
    await page.keyboard.press('Enter')

    await expect(page.getByText('configured', { exact: true }).first()).toBeVisible()
    // The key landed in pi-web-access's real config location (the sandboxed
    // agent dir is its highest-precedence directory).
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(join(soloAgentDir, 'web-search.json'), 'utf8'))
            .braveApiKey
        } catch {
          return undefined
        }
      })
      .toBe('BSA_e2e_123')
  } finally {
    await shutdown(harness)
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('claude provider tab proves the chain end to end (stubbed claude + pi)', async () => {
  // A fake claude via the gated PHOSPHOR_CLAUDE_BIN override — PATH games are
  // machine-dependent (a developer's real install shadows the fake). It answers
  // `auth status`, `auth login`, and `-p /usage` (the live-usage snapshot),
  // the surfaces the tab drives; the login branch reproduces the real CLI's
  // shape (URL on stdout, code read from stdin).
  const claudeDir = await scratchDir('phosphor-e2e-claude-')
  await writeFile(
    join(claudeDir, 'claude'),
    '#!/bin/sh\n' +
      'case "$1 $2" in\n' +
      '  "auth login")\n' +
      '    echo "Opening browser to sign in..."\n' +
      '    echo "If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?state=e2e"\n' +
      '    printf "Paste code here if prompted > "\n' +
      '    read code\n' +
      '    echo "Login successful."\n' +
      '    ;;\n' +
      '  "-p /usage")\n' +
      "    cat <<'USAGE_EOF'\n" +
      '    {"is_error":false,"num_turns":0,"total_cost_usd":0,"result":"You are currently using your subscription to power your Claude Code usage\\n\\nCurrent session: 40% used \\u00b7 resets Jan 2 at 9am\\nCurrent week (all models): 51% used \\u00b7 resets Jan 2 at 9am\\n"}\n' +
      'USAGE_EOF\n' +
      '    ;;\n' +
      '  *) case "$1" in\n' +
      '       --version) echo "2.1.219 (stub)";;\n' +
      '       auth) echo \'{"loggedIn": true, "authMethod": "claude.ai", "email": "e2e@test", "subscriptionType": "max"}\';;\n' +
      '     esac;;\n' +
      'esac\n',
  )
  await chmod(join(claudeDir, 'claude'), 0o755)
  const soloAgentDir = privateAgentDir()
  await writeFile(
    join(soloAgentDir, 'settings.json'),
    JSON.stringify({ packages: ['npm:@saccolabs/pi-claude-cli'] }),
  )

  const harness = await launch({
    agentDir: soloAgentDir,
    env: { PHOSPHOR_CLAUDE_BIN: join(claudeDir, 'claude') },
  })
  try {
    await openWorkspace(harness.page)
    const page = harness.page

    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('button', { name: 'Claude Code', exact: true }).click()

    // Health card sees the fake binary; the accounts list sees its auth state.
    await expect(page.getByText(/v2\.1\.219 at /)).toBeVisible()
    await expect(page.getByText('e2e@test · max')).toBeVisible()

    // The existing login is seeded as account one, and it keeps the CLI's own
    // keychain entry — the routing picker only appears once an account exists.
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Route new sessions' })).toBeVisible()

    // Usage lives under the account that spends it. Opening the row runs
    // `claude -p /usage` under that account's credential through the same
    // override: real spawn, real parse, real IPC — the stub's JSON is shaped
    // like a live capture, so this is the end-to-end proof of the plan bars.
    await expect(page.getByText('no live session')).toBeVisible()
    await page.getByRole('button', { expanded: false, name: /e2e@test/ }).click()
    await expect(page.getByText('5-hour window')).toBeVisible()
    await expect(page.getByText(/40% used/).first()).toBeVisible()
    await expect(page.getByText('Weekly window')).toBeVisible()
    await expect(page.getByText(/51% used/)).toBeVisible()
    await expect(page.getByText('Sessions on this account')).toBeVisible()

    // Re-authenticating is in-app: the CLI's sign-in runs with piped stdio, so
    // the paste-code box is the whole UI it needs — no terminal, no pty.
    await page.getByRole('button', { name: 'Sign in again' }).click()
    await expect(page.getByPlaceholder('Paste code')).toBeVisible()
    await page.getByPlaceholder('Paste code').fill('e2e-code')
    await page.getByRole('button', { name: 'Continue' }).click()
    // Back to a settled row — completion is read from `auth status`, never from
    // the CLI's "Login successful." prose.
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible()
    await expect(page.getByText('e2e@test · max')).toBeVisible()

    // The one-click proof runs through the (stubbed) pi print mode.
    await page.getByRole('button', { name: 'Test provider' }).click()
    await expect(page.getByText('phosphor-provider-ok')).toBeVisible()
    await expect(page.getByText('Round-trip confirmed', { exact: false })).toBeVisible()
  } finally {
    await shutdown(harness)
    await rm(claudeDir, { recursive: true, force: true })
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('a sandbox with a chat open in it can still be renamed, and keeps its chats', async () => {
  const harness = await launch({
    userDataDir: await scratchDir('phosphor-e2e-sandbox-rename-'),
  })
  const { page, workspace } = harness
  try {
    await openWorkspace(page)

    // "No folder" mints a sandbox and points the home screen at it.
    await page.getByTestId('workspace-chip').click()
    await page.getByText('No folder').click()
    await expect(page.getByPlaceholder('Describe a task or ask a question')).toBeVisible({
      timeout: 20_000,
    })
    await page.getByPlaceholder('Describe a task or ask a question').fill('scratch work')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByPlaceholder(/Describe a task…/i)).toBeVisible({ timeout: 20_000 })

    // Wait for the row to reach disk — a live session's transcript is what the
    // rename has to carry across, and pi writes it only when the turn ends.
    await expect(page.getByTestId('session-row').first()).toBeVisible({ timeout: 20_000 })

    const sandboxGroup = page
      .getByTestId('workspace-group')
      .filter({ hasNotText: basename(workspace) })
    const before = (await sandboxGroup.textContent()) ?? ''
    expect(before).not.toBe('')

    await sandboxGroup.locator('..').getByTestId('workspace-group-menu').click()
    await page.getByTestId('workspace-group-rename-sandbox').click()

    // The chat that has to close is stated before the user commits, not after.
    await expect(page.getByText(/Closes 1 running chat/)).toBeVisible()

    await page.getByTestId('prompt-input').fill('renamed-scratch')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()

    // The regression this guards: nothing reclaims an idle pi, so the session
    // started above stayed live forever and main refused the rename for the
    // rest of the launch — from the one menu a user goes looking for it in.
    // Verified to fail without the fix, on this very assertion.
    await expect(
      page.getByTestId('workspace-group').filter({ hasText: 'renamed-scratch' }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('workspace-group').filter({ hasText: before })).toHaveCount(0)

    // And the chat came with it: the transcript directory is named after the
    // mangled cwd, so a rename that moves only the folder loses the history.
    await expect(
      page.locator('[data-testid="session-row"][data-workspace="renamed-scratch"]').first(),
    ).toBeVisible({ timeout: 20_000 })

    // The row being there is not the same as the chat opening. pi reads the
    // cwd back out of the session header and exits 1 before the RPC loop when
    // it no longer exists, so a rename that moved the file but not the value
    // inside it left every chat in the sandbox listed and un-openable. Found
    // in the wild; the transcript directory is located by suffix rather than
    // by re-deriving pi's mangling here, which would just duplicate the rule.
    const sessionsRoot = join(agentDir, 'sessions')
    const movedDir = (await readdir(sessionsRoot)).find((name) =>
      name.endsWith('renamed-scratch--'),
    )
    expect(movedDir).toBeDefined()
    const transcripts = (await readdir(join(sessionsRoot, movedDir!))).filter((name) =>
      name.endsWith('.jsonl'),
    )
    expect(transcripts.length).toBeGreaterThan(0)
    for (const name of transcripts) {
      const text = await readFile(join(sessionsRoot, movedDir!, name), 'utf8')
      const header = JSON.parse(text.split('\n')[0]!)
      expect(header.cwd.endsWith(`${sep}renamed-scratch`)).toBe(true)
    }
  } finally {
    await shutdown(harness)
  }
})

test('a project can be removed from the sidebar, closing its chats and keeping its files', async () => {
  const harness = await launch({
    userDataDir: await scratchDir('phosphor-e2e-remove-project-'),
  })
  const { page, workspace } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()
    await expect(page.getByTestId('session-row').first()).toContainText('Stub Session Title', {
      timeout: 30_000,
    })
    // The title can land before the turn ends, and a chat mid-turn refuses
    // the removal. The idle composer is what says the chat is live but idle.
    await expect(page.getByPlaceholder(/^Describe a task…/)).toBeVisible({ timeout: 30_000 })

    const group = page.getByTestId('workspace-group').filter({ hasText: basename(workspace) })
    await group.locator('..').getByTestId('workspace-group-menu').click()
    // Feedback #326: this used to exist only in Settings, and nobody found it.
    const remove = page.getByTestId('workspace-group-remove')
    await expect(remove).toHaveText('Remove from sidebar')
    await remove.click()
    await expect(remove).toHaveText('Remove? Files stay on disk')
    await remove.click()

    // The live chat would otherwise hold the group in the sidebar.
    await expect(group).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByTestId('session-row')).toHaveCount(0)
    expect((await stat(workspace)).isDirectory()).toBe(true)
  } finally {
    await shutdown(harness)
  }
})

test('the workspace header carries fixed search / new / menu controls', async () => {
  const harness = await launch({
    userDataDir: await scratchDir('phosphor-e2e-header-'),
  })
  const { page } = harness
  try {
    await openWorkspace(page)

    // All three are permanent, not hover-revealed: a control you cannot see is
    // a control you do not know exists.
    await expect(page.getByTestId('workspace-group-search').first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByTestId('workspace-group-new-session').first()).toBeVisible()
    await expect(page.getByTestId('workspace-group-menu').first()).toBeVisible()

    // Select-all is not a fourth icon: it moved into the workspace menu when
    // search took its place.
    await page.getByTestId('workspace-group-menu').first().click()
    await expect(page.getByTestId('workspace-group-select')).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('the workspace header filters lanes on Enter and restores them on Escape', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start session/i }).click()

    // Wait for the named row: the title is what the filter matches on.
    const row = page.getByTestId('session-row').first()
    await expect(row).toContainText('Stub Session Title', { timeout: 30_000 })

    // The bar opens under the header, focused, and typing alone filters
    // nothing — Enter is the commit, so the list cannot jump mid-keystroke.
    await page.getByTestId('workspace-group-search').first().click()
    const input = page.getByTestId('lane-search-input')
    await expect(input).toBeFocused()
    await input.fill('zzz no such lane')
    await expect(row).toBeVisible()

    await input.press('Enter')
    await expect(page.getByTestId('lane-search-empty')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('session-row')).toHaveCount(0)

    // The clear control is earned by an applied filter, and retracts both the
    // filter and the bar — a closed bar must never still be hiding lanes.
    await page.getByTestId('lane-search-clear').click()
    await expect(page.getByTestId('lane-search-input')).toHaveCount(0)
    await expect(row).toBeVisible()

    // Order-free terms across the title, then Escape as the second retraction.
    await page.getByTestId('workspace-group-search').first().click()
    await page.getByTestId('lane-search-input').fill('title stub')
    await page.getByTestId('lane-search-input').press('Enter')
    await expect(row).toBeVisible()
    await expect(page.getByTestId('lane-search-empty')).toHaveCount(0)

    await page.getByTestId('lane-search-input').press('Escape')
    await expect(page.getByTestId('lane-search-input')).toHaveCount(0)
    await expect(row).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('a renderer reload re-adopts the live session instead of orphaning it', async () => {
  // The leak this guards: the pi subprocess registry lives in main, the
  // renderer's live map is plain store state. A reload (HMR, crash,
  // re-navigation) used to hand the renderer an empty map while every
  // ~200 MB child kept running until quit — and resuming the same session
  // file then spawned a SECOND process against it.
  const userDataDir = await scratchDir('phosphor-e2e-reload-')
  const workspace = await scratchDir('phosphor-e2e-')

  try {
    const harness = await launch({ workspace, userDataDir })
    try {
      await openWorkspace(harness.page)
      await harness.page.getByPlaceholder('Describe a task or ask a question').fill('hello')
      await harness.page.getByRole('button', { name: /Start session/i }).click()
      await expect(harness.page.getByPlaceholder(/Describe a task…/i)).toBeVisible({
        timeout: 20_000,
      })
      // The fleet hub needs the session's diskPath (get_state) before a
      // reload can match it; the disk-backed sidebar row is that signal.
      await expect(
        harness.page.locator('[data-testid="session-row"]:not([data-pending])').first(),
      ).toBeVisible({ timeout: 20_000 })

      // Through the real IPC surface — the same channel the reload uses.
      const pidBefore = await harness.page.evaluate(() =>
        (
          window as unknown as {
            phosphor: { invoke: (c: string) => Promise<Array<{ pid?: number }>> }
          }
        ).phosphor
          .invoke('pi:listLiveSessions')
          .then((live) => live.map((s) => s.pid)),
      )
      expect(pidBefore).toHaveLength(1)

      await harness.page.reload()

      // The reloaded renderer must show the SAME live session again…
      await expect(harness.page.getByPlaceholder(/Describe a task…/i)).toBeVisible({
        timeout: 30_000,
      })
      // …and main must still own exactly one pi process — the original.
      const pidAfter = await harness.page.evaluate(() =>
        (
          window as unknown as {
            phosphor: { invoke: (c: string) => Promise<Array<{ pid?: number }>> }
          }
        ).phosphor
          .invoke('pi:listLiveSessions')
          .then((live) => live.map((s) => s.pid)),
      )
      expect(pidAfter).toEqual(pidBefore)
    } finally {
      await harness.app.close()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('bundled artifact skill is editable, removable across restart and explicitly restorable', async () => {
  const soloAgentDir = privateAgentDir()
  const userDataDir = await scratchDir('phosphor-e2e-bundled-skill-')
  let harness = await launch({ agentDir: soloAgentDir, userDataDir })
  const file = join(soloAgentDir, 'skills/visual-artifacts/SKILL.md')
  const openSkill = async () => {
    await harness.page.getByRole('button', { name: 'Skills', exact: true }).click()
    await harness.page.getByText('visual-artifacts', { exact: true }).click()
  }
  try {
    await openWorkspace(harness.page)
    const original = await readFile(file, 'utf8')
    expect(original).toContain('Choose the medium')
    await openSkill()
    await harness.page.getByRole('button', { name: 'files', exact: true }).click()
    await harness.page.getByRole('button', { name: /references\/mermaid.md/ }).click()
    await harness.page.getByRole('button', { name: 'preview', exact: true }).click()
    await expect(harness.page.getByRole('button', { name: 'Expand Mermaid diagram' })).toHaveCount(
      3,
    )
    await expect(harness.page.getByText(/Mermaid parse error/)).toHaveCount(0)
    await harness.page.getByRole('button', { name: 'files', exact: true }).click()
    await harness.page.getByRole('button', { name: /^SKILL.md/ }).click()
    await harness.page.getByRole('button', { name: 'Edit source', exact: true }).click()
    await harness.page
      .getByRole('textbox', { name: 'Edit SKILL.md', exact: true })
      .fill(`${original}\nMy custom visual rule.\n`)
    await harness.page.getByRole('button', { name: 'Save source', exact: true }).click()
    await expect.poll(() => readFile(file, 'utf8')).toContain('My custom visual rule.')
    await shutdown(harness)
    harness = await launch({ agentDir: soloAgentDir, userDataDir })
    await openWorkspace(harness.page)
    expect(await readFile(file, 'utf8')).toContain('My custom visual rule.')
    await openSkill()
    await harness.page.getByRole('button', { name: 'Hide from model', exact: true }).click()
    await expect(harness.page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible()
    await expect.poll(() => readFile(file, 'utf8')).toContain('disable-model-invocation: true')
    await harness.page.getByRole('button', { name: 'Delete', exact: true }).click()
    // Deleting asks first; nothing leaves disk until the user confirms.
    expect(await readFile(file, 'utf8')).toContain('My custom visual rule.')
    await harness.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Move to Trash', exact: true })
      .click()
    await expect.poll(async () => readFile(file, 'utf8').catch(() => 'removed')).toBe('removed')
    await shutdown(harness)
    harness = await launch({ agentDir: soloAgentDir, userDataDir })
    await openWorkspace(harness.page)
    await harness.page.getByRole('button', { name: 'Skills', exact: true }).click()
    await expect(harness.page.getByText('visual-artifacts', { exact: true })).toHaveCount(0)
    await harness.page.getByRole('button', { name: 'Restore artifact skill', exact: true }).click()
    await expect(harness.page.getByText('visual-artifacts', { exact: true })).toBeVisible()
    expect(await readFile(file, 'utf8')).toBe(original)
  } finally {
    await shutdown(harness)
  }
})

test('skills page lists a seeded skill, and creates a new one on disk', async () => {
  // Solo agent dir: the created skill writes into <agentDir>/skills, and the
  // shared dir would leak it into every later test's resolution.
  const soloAgentDir = privateAgentDir()
  await mkdir(join(soloAgentDir, 'skills', 'seeded-e2e-skill'), { recursive: true })
  await writeFile(
    join(soloAgentDir, 'skills', 'seeded-e2e-skill', 'SKILL.md'),
    '---\nname: seeded-e2e-skill\ndescription: A fixture skill for the e2e suite\n---\n\n# Seeded\n',
  )
  const harness = await launch({
    agentDir: soloAgentDir,
    userDataDir: await scratchDir('phosphor-e2e-skills-'),
  })
  const { page } = harness
  try {
    await openWorkspace(page)

    // A global page: opens straight from the home screen, no session needed
    // (the old right-pane version silently no-oped here).
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await expect(page.getByTestId('global-page')).toBeVisible()

    // Yours: the seeded skill resolves (stub answers get_commands without
    // skills, so this exercises the scan fallback end to end).
    await expect(page.getByText('seeded-e2e-skill')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('A fixture skill for the e2e suite')).toBeVisible()

    // Detail view renders the bundle.
    await page.getByText('seeded-e2e-skill').click()
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible()
    await page.getByRole('button', { name: '← Skills' }).click()

    // Outcome-first discovery: evidence before opt-in, with external plugins kept separate.
    await page.getByRole('button', { name: 'Discover' }).click()
    await expect(
      page.getByRole('heading', { name: 'What should your agent do better?' }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Add react-best-practices', exact: true }),
    ).toBeHidden()
    await page.getByRole('button', { name: 'Audit & verify', exact: true }).click()
    await expect(page.getByText('Catch unit and scaling mistakes')).toBeVisible()
    await page.getByText('Compatibility & setup', { exact: false }).click()
    await expect(page.getByRole('button', { name: 'Review upstream setup ↗' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Add / })).toHaveCount(0)
    await page.getByRole('button', { name: 'All outcomes', exact: true }).click()
    await page.getByPlaceholder('Search skills').fill('waterfalls')
    await expect(
      page.getByRole('button', { name: 'Add react-best-practices', exact: true }),
    ).toBeVisible()
    await expect(page.getByText('Catch unit and scaling mistakes')).toHaveCount(0)
    await page.getByPlaceholder('Search skills').fill('no-such-skill')
    await expect(page.getByText(/No matches in this outcome/)).toBeVisible()
    await page.getByPlaceholder('Search skills').fill('')

    // Create flow writes a real bundle into the global root.
    await page.getByRole('button', { name: 'New skill' }).click()
    await page.getByPlaceholder('weekly-status-report').fill('made-in-e2e')
    await page
      .getByPlaceholder(/Generate weekly status reports/)
      .fill('A skill created by the e2e suite.')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect
      .poll(async () => {
        try {
          const raw = await readFile(
            join(soloAgentDir, 'skills', 'made-in-e2e', 'SKILL.md'),
            'utf8',
          )
          return raw.includes('name: made-in-e2e')
        } catch {
          return false
        }
      })
      .toBe(true)
    // Back to Yours (the catalog tab is still selected) for the new row.
    await page.getByRole('button', { name: /^Yours/ }).click()
    await expect(page.getByText('made-in-e2e').first()).toBeVisible({ timeout: 10_000 })
  } finally {
    await shutdown(harness)
    await rm(soloAgentDir, { recursive: true, force: true })
  }
})

test('an artifact link the model wrote opens the Artifacts pane', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('artifactlink please')
    await page.getByRole('button', { name: /Start session/i }).click()

    const artifactLink = page.getByRole('link', { name: 'Preview the design' })
    await expect(artifactLink).toHaveAttribute('data-tooltip', 'Open in Artifacts pane', {
      timeout: 30_000,
    })
    // No href, same as a file link: nothing can navigate the app away.
    expect(await artifactLink.getAttribute('href')).toBeNull()

    // The pane auto-opens on a session's first artifact, so close it first —
    // otherwise this passes on a pane the link never touched. Exact role match:
    // the link's own title ("Open in Artifacts pane") is a getByTitle substring.
    await page.getByRole('button', { name: 'Artifacts pane', exact: true }).click()
    await expect(page.getByTestId('artifact-scroll')).toBeHidden()

    await artifactLink.click()
    await expect(page.getByTestId('artifact-scroll')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('right-pane')).toContainText('E2E Linked Doc')

    // The same message also writes the URL as inline code — the form models use
    // most — which is a link only because remarkArtifactLinks promotes it.
    await page.getByRole('button', { name: 'Artifacts pane', exact: true }).click()
    await expect(page.getByTestId('artifact-scroll')).toBeHidden()
    await page.getByRole('link', { name: 'artifact://e2e-linked-doc' }).click()
    await expect(page.getByTestId('artifact-scroll')).toBeVisible({ timeout: 10_000 })
  } finally {
    await shutdown(harness)
  }
})

test('an artifact outlives its session’s context, a restart and the session itself', async () => {
  const userDataDir = await scratchDir('phosphor-e2e-artifact-store-')
  const first = await launch({ userDataDir })
  const { workspace } = first
  try {
    await openWorkspace(first.page)
    await first.page
      .getByPlaceholder('Describe a task or ask a question')
      .fill('artifactlink please')
    await first.page.getByRole('button', { name: /Start session/i }).click()
    await expect(first.page.getByTestId('right-pane')).toContainText('E2E Linked Doc', {
      timeout: 30_000,
    })
    // The turn's last message: by then the result is in the session file.
    // Closing earlier kills pi before it writes it, as it would real pi.
    await expect(first.page.getByRole('link', { name: 'Preview the design' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(first.page.locator('[data-testid="session-row"]:not([data-pending])')).toHaveCount(
      1,
      { timeout: 30_000 },
    )
  } finally {
    await first.app.close()
  }

  const second = await launch({ workspace, userDataDir })
  const { page } = second
  try {
    // The stub's get_messages answers nothing: the same view of the transcript
    // pi gives once compaction has dropped the artifact from context. This is
    // what emptied the pane on a provider switch.
    const row = page.getByTestId('session-row')
    await expect(row).toHaveCount(1, { timeout: 30_000 })
    await row.click()
    await expect(page.getByPlaceholder(/Describe a task…/i)).toBeVisible({ timeout: 20_000 })
    if (!(await page.getByTestId('artifact-scroll').isVisible())) {
      await page.getByRole('button', { name: 'Artifacts pane', exact: true }).click()
    }
    await expect(page.getByTestId('right-pane')).toContainText('E2E Linked Doc', {
      timeout: 10_000,
    })

    // The global page lists it, and keeps it once the session is deleted.
    await page.getByRole('button', { name: 'Artifacts', exact: true }).click()
    const listed = page.getByTestId('global-page').getByRole('button', { name: /E2E Linked Doc/ })
    await expect(listed).toBeVisible({ timeout: 10_000 })
    await expect(listed).not.toContainText('Session deleted')

    await row.click({ button: 'right' })
    await page
      .getByTestId('context-menu')
      .getByRole('button', { name: /^Delete/ })
      .click()
    await page.getByRole('button', { name: 'Delete session', exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect(listed).toContainText('Session deleted', { timeout: 10_000 })

    // It opens read-only, here, and can then be removed for good.
    await listed.click()
    await expect(page.getByText('The artifact the chat link points at.')).toBeVisible()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByText('No artifacts yet')).toBeVisible()
  } finally {
    await shutdown(second)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a link to a spec the model wrote opens it in the Files pane', async () => {
  const harness = await launch()
  const { page, workspace } = harness
  try {
    await mkdir(join(workspace, 'docs'), { recursive: true })
    await writeFile(
      join(workspace, 'docs', 'plan.md'),
      Array.from({ length: 50 }, (_, i) => `line ${i + 1}: plan body`).join('\n'),
    )
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('speclink')
    await page.getByRole('button', { name: /Start session/i }).click()

    // The web URL keeps its href (it opens in the default browser, so the test
    // must never click it — that would launch a real browser on the runner).
    await expect(page.getByRole('link', { name: '#214' })).toHaveAttribute(
      'href',
      'https://github.com/agustinsacco/Phosphor/pull/214',
      { timeout: 30_000 },
    )

    // The path link has no href at all: nothing can navigate the app away.
    const specLink = page.getByRole('link', { name: 'docs/plan.md' })
    await expect(specLink).toHaveAttribute('data-tooltip', 'Open in Files pane')
    expect(await specLink.getAttribute('href')).toBeNull()

    await specLink.click()
    await expect(page.getByTestId('right-pane')).toBeVisible()
    await expect(page.locator('[data-tooltip="docs/plan.md"]')).toBeVisible()
    // Markdown opens rendered; the source stays one click away.
    await expect(
      page.getByTestId('right-pane').locator('.md-content').getByText('line 1: plan body'),
    ).toBeVisible()
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Source' }).click()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('line 1: plan body')
  } finally {
    await shutdown(harness)
  }
})
