#!/usr/bin/env node
/**
 * Regenerate the README screenshots.
 *
 *   npm run build && node tools/scripts/capture-readme-shots.mjs
 *   ONLY=settings,tree node tools/scripts/capture-readme-shots.mjs   # partial rerun
 *   OUT_DIR=apps/site/shots-raw MAX_WIDTH=0 ONLY=subagents node tools/scripts/capture-readme-shots.mjs
 *
 * What is real and what is not: this launches the BUILT app (`out/`) through
 * Playwright's Electron driver, so every pixel of chrome, layout, colour and
 * interaction is Phosphor as it ships. The transcript itself is the deterministic
 * e2e pi stub (`apps/desktop/e2e/fixtures/pi-stub.cjs`), with no model, API key or network,
 * so the assistant prose and artifact titles are the stub's fixed script. That
 * is deliberate: the shots must be reproducible from a clean clone, and a real
 * session's transcript would be somebody else's code.
 *
 * Requires `npm run build` first: main.ts picks dev-vs-built from
 * ELECTRON_RENDERER_URL, which is stripped below so this always means `out/`.
 */
import { desktopElectronLaunchOptions } from './desktop-electron-launch.mjs'
import { prepareReadmeShots } from './shots/readme-setup.mjs'
import {
  startSession,
  captureChatAndChanges,
  captureFiles,
  captureTerminalAndHome,
  captureArtifacts,
  captureSubagents,
  captureSettings,
} from './shots/readme-scenarios.mjs'
import { rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const appRoot = join(repoRoot, 'apps/desktop')
const piStub = join(appRoot, 'e2e', 'fixtures', 'pi-stub.cjs')
/** As in capture-live-shots.mjs: the site sets OUT_DIR and MAX_WIDTH=0 (device scale). */
const outDir = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(repoRoot, 'docs', 'img')
const maxWidth = Number(process.env.MAX_WIDTH ?? 1440)

/** Only these shots (comma-separated names, without .png). Empty = all. */
const only = (process.env.ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

async function main() {
  const { root, agentDir, env } = await prepareReadmeShots({ outDir, piStub })
  // --disable-gpu puts Chromium on the software compositor, so a capture
  // rasterises the current frame instead of reading a GPU surface that may
  // still hold the view behind it — which is what ghosted these shots.
  const app = await electron.launch({
    ...desktopElectronLaunchOptions([appRoot, '--disable-gpu']),
    env,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Screenshots want the settled frame, so the UI's transitions are asked to
  // step short. (Not by overriding CSS: outgoing panes unmount on
  // `transitionend`, and killing the transition strands them on screen.)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const shots = []

  const state = { app, page, outDir, maxWidth, only, shots }
  try {
    await startSession(state)
    await captureChatAndChanges(state)
    await captureFiles(state)
    await captureTerminalAndHome(state)
    await captureArtifacts(state)
    await captureSubagents(state)
    await captureSettings(state)
  } finally {
    console.log(`captured: ${shots.join(', ') || 'none'}`)
    // Bounded: a close that never resolves (a held stub turn, a stuck
    // renderer) used to swallow the real error behind a silent hang.
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise((done) => setTimeout(() => done(false), 15_000)),
    ])
    if (!closed) app.process().kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
