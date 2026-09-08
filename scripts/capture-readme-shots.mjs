#!/usr/bin/env node
/**
 * Regenerate the README screenshots.
 *
 *   npm run build && node scripts/capture-readme-shots.mjs
 *   ONLY=settings,tree node scripts/capture-readme-shots.mjs   # partial rerun
 *
 * What is real and what is not: this launches the BUILT app (`out/`) through
 * Playwright's Electron driver, so every pixel of chrome, layout, colour and
 * interaction is Phosphor as it ships. The transcript itself is the deterministic
 * e2e pi stub (`e2e/fixtures/pi-stub.cjs`) — no model, no API key, no network —
 * so the assistant prose and artifact titles are the stub's fixed script. That
 * is deliberate: the shots must be reproducible from a clean clone, and a real
 * session's transcript would be somebody else's code.
 *
 * Requires `npm run build` first: main.ts picks dev-vs-built from
 * ELECTRON_RENDERER_URL, which is stripped below so this always means `out/`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const piStub = join(repoRoot, 'e2e', 'fixtures', 'pi-stub.cjs')
const outDir = join(repoRoot, 'docs', 'img')

/** Only these shots (comma-separated names, without .png). Empty = all. */
const only = (process.env.ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const wanted = (name) => only.length === 0 || only.includes(name)

const HOME_PROMPT = 'Describe a task or ask a question'

/** The prompt the stub answers with an edit + an artifact. */
const TASK = 'Update hello.ts'

async function main() {
  await mkdir(outDir, { recursive: true })

  // A named scratch project, not an mkdtemp slug: the folder name IS the
  // workspace chip in every shot, and it reads better as a project than as
  // `phosphor-shots-Qk2p1A`. Seeded as a git repo so the branch chip is real.
  const root = await mkdtemp(join(tmpdir(), 'phosphor-shots-'))
  const workspace = join(root, 'welcome-app')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'hello.ts'), 'export function hello() {\n  return "old"\n}\n')
  await writeFile(
    join(workspace, 'README.md'),
    '# welcome-app\n\nA tiny demo project used to show Phosphor in its own README.\n',
  )
  const git = (args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'shots@phosphor.dev'])
  git(['config', 'user.name', 'Phosphor shots'])
  git(['add', '-A'])
  git(['commit', '-m', 'initial'])

  // Never the developer's real ~/.pi: the stub writes session files, and prefs
  // go to a userData dir main.ts derives from its own pid for e2e runs.
  const agentDir = mkdtempSync(join(tmpdir(), 'phosphor-shots-agent-'))

  const env = { ...process.env, NODE_ENV: 'production' }
  for (const key of ['ELECTRON_RENDERER_URL', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_CLI_ARGS']) {
    delete env[key]
  }
  Object.assign(env, {
    PHOSPHOR_PI_STUB: piStub,
    PHOSPHOR_E2E_WORKSPACE: workspace,
    PHOSPHOR_TEST_USER_DATA: '1',
    PI_CODING_AGENT_DIR: agentDir,
    // Mapped windows on purpose. The e2e suite leaves windows unmapped so no
    // run steals your screen, but an unmapped window never repaints cleanly:
    // captures come out with stale layers ghosting through the new frame.
    // A screenshot run is allowed to be seen — that is what it is for.
    PHOSPHOR_E2E_SHOW: '1',
  })

  // --disable-gpu puts Chromium on the software compositor, so a capture
  // rasterises the current frame instead of reading a GPU surface that may
  // still hold the view behind it — which is what ghosted these shots.
  const app = await electron.launch({ args: [repoRoot, '--disable-gpu'], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Screenshots want the settled frame, so the UI's transitions are asked to
  // step short. (Not by overriding CSS: outgoing panes unmount on
  // `transitionend`, and killing the transition strands them on screen.)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const shots = []

  /*
   * Panel and session switches cross-fade, keeping the outgoing layer mounted
   * until its transition ends. Capturing inside that window puts two states in
   * one frame, so every switch is followed by a settle. (Overriding transitions
   * away does NOT help: the outgoing layer unmounts on `transitionend`, so
   * killing the transition strands it there permanently.)
   */
  const settle = async (p, ms = 2400) => p.waitForTimeout(ms)

  /*
   * A screenshot taken after a view switch can come back with the previous
   * view ghosted through the new one: Chromium repaints the damaged rectangle
   * only, and for a window nobody is looking at, the damage from swapping a
   * pane is not always enough to clear the layer underneath. Waiting does not
   * help — the stale pixels are stable. Resizing is what forces a full
   * repaint, so nudge the window by a pixel and back before grabbing.
   */
  const nudge = (dy) =>
    app.evaluate(({ BrowserWindow }, dy) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) return
      if (!win.isVisible()) win.show()
      win.moveTop()
      win.focus()
      const b = win.getBounds()
      win.setBounds({ ...b, height: b.height + dy })
    }, dy)

  /*
   * Grab through Electron's own capturePage rather than CDP: it rasterises the
   * window's current frame at the backing scale, so a switch that CDP renders
   * as two stacked layers (a ghost of the outgoing pane behind the incoming
   * one) comes out as one clean image. capturePage is at device pixels, so
   * downscale back to CSS size with sips when it is available (macOS).
   */
  const shot = async (name) => {
    if (!wanted(name)) return
    const path = join(outDir, `${name}.png`)
    await nudge(-1)
    await page.waitForTimeout(200)
    await nudge(1)
    await page.waitForTimeout(400)
    const dataUrl = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      return win.capturePage().then((image) => image.toDataURL())
    })
    await writeFile(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
    try {
      execFileSync('sips', ['-Z', '1440', path, '--out', path], { stdio: 'ignore' })
    } catch {
      // no sips (non-macOS): keep the device-scale original
    }
    shots.push(name)
    console.log(`  ✓ ${name}.png (${Math.round(statSync(path).size / 1024)} KB)`)
  }

  try {
    // ---- Reach the workspace home (the app may restore a session instead).
    const picker = page.getByRole('button', { name: /Open Folder/i })
    const homeComposer = page.getByPlaceholder(HOME_PROMPT)
    await picker.or(homeComposer).first().waitFor({ timeout: 60_000 })
    if (await picker.isVisible()) await picker.click()
    await homeComposer.waitFor({ timeout: 30_000 })

    // The project's own name, not the mkdtemp slug.
    await page.getByTestId('workspace-chip').waitFor({ timeout: 15_000 })

    // ---- 1. One real session, from the home composer, on the checked-out
    // branch (unticked so no worktree chrome lands in the shots).
    await page.getByRole('checkbox', { name: 'new branch' }).uncheck()
    await homeComposer.fill(TASK)
    await page.getByRole('button', { name: /Start session/i }).click()
    await page.getByText(/Done:\s*hello\.ts\s*updated\./).waitFor({ timeout: 60_000 })

    // Auto-naming hands the stub's fixed title back, which reads like a bug in
    // a screenshot. Renaming through the row's inline editor is the ordinary
    // user path (and really persists to the session file), so the sidebar and
    // title bar carry a sane name.
    const row = page.getByTestId('session-row').first()
    await row.waitFor({ timeout: 30_000 })
    await row.dblclick()
    const rename = page.getByLabel('Session name')
    await rename.waitFor({ timeout: 10_000 })
    await rename.fill('Update hello world greeting')
    await page.keyboard.press('Enter')
    await row.click()

    // ---- 2. Chat: the settled activity run expanded, with the edit card open
    // on its diff. The group collapses once the turn lands, so expand it.
    const summary = page.getByTestId('activity-summary').first()
    await summary.waitFor({ timeout: 30_000 })
    if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click()
    const editCard = page.getByRole('button', { name: /Edited\s+hello\.ts/ })
    await editCard.waitFor({ timeout: 20_000 })
    await editCard.click()
    // The artifacts pane opens itself on a project's first artifact; close it so
    // this shot is the conversation, and let the panel cross-fade settle (it is
    // a real transition — capturing early ghosts two panels into one frame).
    await page.getByTitle('Artifacts pane').click()
    await settle(page, 3500)
    await shot('chat')

    // ---- 3. The Changes pane: the session's touched files with per-file diff.
    await page.getByTitle(/Changes pane/).click()
    await page.getByText('Files changed').waitFor({ timeout: 15_000 })
    await page.getByText('hello.ts').first().waitFor({ timeout: 15_000 })
    await settle(page, 3500)
    await shot('changes')

    // ---- 4. Files pane on its default side (right): explorer + Monaco on the
    // file the session touched.
    await page.getByTitle(/Files pane/).click()
    await settle(page, 3500)
    // Scoped to the pane: the transcript's edit card also reads "hello.ts".
    await page.getByTestId('right-pane').getByRole('button', { name: 'hello.ts' }).click()
    await settle(page, 3000)
    await shot('files')

    // ---- 5. The same pane docked LEFT of the chat — every pane carries a
    // side-swap control, and the orientation persists per session.
    await page.getByTitle('Move pane to the left').click()
    await settle(page, 3500)
    await shot('files-left')
    await page.getByTitle('Move pane to the right').click()
    await settle(page, 2500)

    // ---- 6. The pane fullscreened over the whole session region.
    await page.getByTitle('Fullscreen pane').click()
    await settle(page, 3000)
    await shot('files-full')
    await page.getByTitle('Exit fullscreen').click()
    await settle(page, 2500)

    // ---- 7. Terminal switched in beside the chat. Panes are switches, not
    // columns: opening Files then Terminal shows only the last one, so this
    // shot is honestly the terminal, and the README says so.
    await page.getByTitle(/Terminal pane/).click()
    await settle(page, 3500)
    await shot('terminal')

    // ---- 8. Home with a live session: mission control. Every card is a
    // projection of main's view of pi's event stream, answerable in place.
    await page.getByRole('button', { name: /^New$/ }).click()
    await page.getByTestId('fleet-session-card').first().waitFor({ timeout: 20_000 })
    await settle(page, 2200)
    await shot('home')

    // ---- 9. Artifacts: a second session whose deliverable is a long document,
    // in the pane that opens by itself on a project's first artifact. Scrolled
    // so the viewer shows body text rather than the gallery header.
    await page.getByRole('button', { name: /^New$/ }).click()
    await homeComposer.waitFor({ timeout: 20_000 })
    await page.getByRole('checkbox', { name: 'new branch' }).uncheck()
    // `longartifact` is the phrase the e2e pi stub branches on.
    await homeComposer.fill('write a longartifact please')
    await page.getByRole('button', { name: /Start session/i }).click()
    const artifactScroll = page.getByTestId('artifact-scroll')
    await artifactScroll.waitFor({ timeout: 60_000 })
    await artifactScroll.evaluate((el) => (el.scrollTop = 260))

    // Rename before the shot: the title bar of a screenshot reading "Stub
    // Session Title" looks like a defect, not a fixture.
    const secondRow = page.getByTestId('session-row').first()
    await secondRow.dblclick()
    const rename2 = page.getByLabel('Session name')
    await rename2.waitFor({ timeout: 10_000 })
    await rename2.fill('Draft the long-form report')
    await page.keyboard.press('Enter')
    await settle(page, 2500)
    await shot('artifacts')

    // ---- 10. Settings → Appearance. It is the tab that carries the theme
    // switch, and picking Light here sets up the last shot.
    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await settle(page)
    await shot('settings')
    await page.getByRole('button', { name: 'Light', exact: true }).click()
    await page.keyboard.press('Escape')

    // ---- 11. The same conversation in the paper theme, so both are on record.
    await page.getByTestId('session-row').first().click()
    await page.getByPlaceholder(/Describe a task…/).waitFor({ timeout: 20_000 })
    await settle(page, 3500)
    await shot('light')
  } finally {
    console.log(`captured: ${shots.join(', ') || 'none'}`)
    await app.close()
    await rm(root, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
