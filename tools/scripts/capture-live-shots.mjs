#!/usr/bin/env node
/**
 * Capture the README screenshots against a REAL pi instance.
 *
 *   npm run build && node tools/scripts/capture-live-shots.mjs
 *   ONLY=home,models node tools/scripts/capture-live-shots.mjs      # partial rerun
 *   WORKSPACE=~/myrepo MODEL_EDIT=glm node tools/scripts/capture-live-shots.mjs
 *   REDACT='my-internal-mcp=knowledge' node tools/scripts/capture-live-shots.mjs
 *
 * The shots are published, and a real ~/.pi shows real account details.
 * Every email address on screen is masked before each capture, and REDACT
 * adds `from=to` text replacements for anything else private: an internal
 * MCP server's name or host, say.
 *
 * Unlike capture-readme-shots.mjs (the deterministic stub runner, kept for
 * CI-reproducible shots), this drives the built app against the developer's
 * own ~/.pi: real providers, real models, real sessions in the sidebar. It
 * runs two real turns — one small edit task in a git WORKTREE (so the main
 * checkout is never touched) and one artifact task — so the transcript,
 * diffs, model chips and token costs in the shots are all genuine.
 *
 * The edit session runs on a pi-NATIVE provider (MODEL_EDIT) on purpose: its
 * edits are pi `edit` tool calls, which render as expandable diff cards and
 * feed the Changes pane. A CLI-side provider (pi-claude-cli) executes its own
 * tools and surfaces them as markers, which the Changes pane does not collect
 * — that session instead demonstrates the artifact flow and the composer.
 *
 * What stays isolated: app prefs. PHOSPHOR_TEST_USER_DATA gives the run its own
 * userData dir, so it neither fights the installed app's single-instance
 * lock nor overwrites its settings. pi's side is NOT isolated on purpose —
 * that is the point.
 *
 * Costs and leftovers, deliberately: the two turns and session auto-naming
 * spend real tokens on whatever provider serves them, and the run leaves
 * behind two real sessions plus one worktree/branch under the workspace's
 * .phosphor/worktrees. Delete them like any other session/worktree if unwanted.
 */
import { desktopElectronLaunchOptions } from './desktop-electron-launch.mjs'
import { mkdir } from 'node:fs/promises'
import { createLiveCapture } from './shots/live-capture.mjs'
import { runLiveScenarios } from './shots/live-scenarios.mjs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const appRoot = join(repoRoot, 'apps/desktop')
/**
 * Where the shots land and how wide they are. The README reads 1440px PNGs
 * out of docs/img; the landing site (apps/site/) wants the same captures at the
 * display's native scale, so it sets OUT_DIR and MAX_WIDTH=0 (keep the
 * device-scale original).
 */
const outDir = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(repoRoot, 'docs', 'img')
const maxWidth = Number(process.env.MAX_WIDTH ?? 1440)

const workspace = process.env.WORKSPACE ?? join(process.env.HOME ?? '', 'phosphor')
/**
 * The edit task, run on a fresh worktree branch. The git/gh prohibition is
 * load-bearing: an earlier phrasing left the agent free to push its worktree
 * branch and open a real PR on the repo mid-shoot.
 */
const TASK_EDIT =
  process.env.TASK_EDIT ??
  'Tighten the intro paragraph of README.md: keep the meaning, cut filler words, fix any typos. One small edit, no restructuring. Edit the file only — do not run git or gh, do not commit, do not push, do not open a PR.'
/** The artifact task, read-only, run on the checked-out branch. */
const TASK_ARTIFACT =
  process.env.TASK_ARTIFACT ??
  'Create a markdown artifact titled "How Phosphor talks to pi": a one-page explainer of the RPC boundary, based on libs/shared/src/rpc.ts and the architecture notes in CLAUDE.md. Do not edit any files.'
/**
 * Who serves each session: a provider filter-chip name plus a model search
 * string. Provider-scoped because several catalogues carry the same model
 * names (bedrock, openrouter and the CLI package all offer Claude Fable).
 */
const PROVIDER_EDIT = process.env.PROVIDER_EDIT ?? 'openai-codex'
const MODEL_EDIT = process.env.MODEL_EDIT ?? 'gpt-5.5'
const PROVIDER_ARTIFACT = process.env.PROVIDER_ARTIFACT ?? 'pi-claude-cli'
const MODEL_ARTIFACT = process.env.MODEL_ARTIFACT ?? 'fable'

const only = (process.env.ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const wanted = (name) => only.length === 0 || only.includes(name)

/** `from=to` pairs, comma-separated, applied to on-screen text before a shot. */
const redactions = (process.env.REDACT ?? '')
  .split(',')
  .map((pair) => pair.split('='))
  .filter(([from, to]) => from && to !== undefined)

async function main() {
  // Said out loud: a REDACT that never reached the process is otherwise
  // invisible until someone reads the published PNGs.
  console.log(
    `redacting: emails${redactions.map(([from]) => `, "${from}"`).join('')}` +
      (redactions.length ? '' : ' only (set REDACT to mask more)'),
  )
  await mkdir(outDir, { recursive: true })

  const env = { ...process.env, NODE_ENV: 'production' }
  for (const key of [
    'ELECTRON_RENDERER_URL',
    'NODE_ENV_ELECTRON_VITE',
    'ELECTRON_CLI_ARGS',
    // Never the stub here — a leftover e2e env var would silently fake the run.
    'PHOSPHOR_PI_STUB',
    'PI_CODING_AGENT_DIR',
  ]) {
    delete env[key]
  }
  Object.assign(env, {
    PHOSPHOR_E2E_WORKSPACE: workspace,
    PHOSPHOR_TEST_USER_DATA: '1',
    PHOSPHOR_E2E_SHOW: '1',
  })

  // Same capture mechanics as capture-readme-shots.mjs — see the comments
  // there for why: software compositor, settle-after-switch, resize nudge,
  // capturePage over CDP.
  const app = await electron.launch({
    ...desktopElectronLaunchOptions([appRoot, '--disable-gpu']),
    env,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { shot, shots } = createLiveCapture({ app, page, outDir, maxWidth, wanted, redactions })
  try {
    await runLiveScenarios(
      { page, shot },
      {
        PROVIDER_EDIT,
        MODEL_EDIT,
        TASK_EDIT,
        PROVIDER_ARTIFACT,
        MODEL_ARTIFACT,
        TASK_ARTIFACT,
      },
    )
  } finally {
    console.log(`captured: ${shots.join(', ') || 'none'}`)
    await quit(app)
  }
}

/**
 * Close the app without hanging. The terminal shot leaves a live shell, so
 * quitting asks "Quit Phosphor?" in a native dialog nobody will answer, and
 * `app.close()` waits on it forever (SIGTERM does not get through either).
 * Answer it with "Stop work and quit" instead, so the app's own teardown still
 * runs: shells killed, pi children disposed, watchers closed.
 */
async function quit(app) {
  await app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    .catch(() => undefined)
  await app.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
