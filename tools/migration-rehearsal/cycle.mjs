import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { restoredConfig, sessionsKept } from './compare.mjs'
import { cli } from './fixture.mjs'
import { readRecord } from './report.mjs'

/**
 * After the move commits: the launches a person makes next. Desktop again on the service, the
 * lanes stopped with the `phosphor` CLI, the break-glass restore, then Desktop in-app again.
 * Every result is a count, a state or a key name; nothing from the copied data is printed.
 */

const DECIDED = /\[migration\] mode decided (\{[^\n]*\})/g
const PROBLEM = /\[([a-z-]+)\] ([^{\n]*(?:fail|refus|error|crash|gone|lost)[^{\n]*)/gi

async function logText(userData) {
  return readFile(join(userData, 'logs/phosphor.log'), 'utf8').catch(() => '')
}

/** Event names only, counted: the payloads can hold paths. */
function problems(text) {
  const counts = {}
  for (const [, scope, event] of text.matchAll(PROBLEM)) {
    const key = `${scope} ${event.trim()}`.slice(0, 80)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** One Desktop launch: wait for its runtime decision, let it settle, then quit as a person does. */
async function launch(ctx, extra, settleMs) {
  const from = (await logText(ctx.roots.userData)).length
  const app = ctx.desktop(extra)
  const deadline = Date.now() + 150000
  let decided = null
  while (Date.now() < deadline && app.running() && !decided) {
    const text = (await logText(ctx.roots.userData)).slice(from)
    const last = [...text.matchAll(DECIDED)].at(-1)
    decided = last?.[1] ? JSON.parse(last[1]) : null
    if (text.includes('[migration] restore refused')) break
    await sleep(250)
  }
  if (decided) await sleep(settleMs)
  const alive = app.running()
  await app.quit()
  const text = (await logText(ctx.roots.userData)).slice(from)
  return {
    mode: decided?.mode ?? null,
    migration: decided?.migration ?? null,
    stayedUp: alive,
    restoreRefused: text.includes('[migration] restore refused'),
    problems: problems(text),
  }
}

function phosphor(ctx, args) {
  const { code, out } = cli(ctx.profile, ctx.host, ctx.env, [...args, '--json'])
  try {
    return { code, result: JSON.parse(out) }
  } catch {
    return { code, result: null }
  }
}

/** Every page of a list op, through the CLI the owner uses. */
function list(ctx, args, field, refusals) {
  const rows = []
  let page
  for (let i = 0; i < 100; i++) {
    const { result } = phosphor(ctx, [...args, ...(page ? ['--page', page] : [])])
    if (result?.status !== 'ok') {
      // The CLI's own fixed refusal text, never data.
      refusals.push(result ? `${result.code}: ${result.text}`.slice(0, 160) : 'unreadable')
      return null
    }
    rows.push(...(result.data?.[field] ?? []))
    page = result.next
    if (!page) return rows
  }
  return null
}

async function transcripts(agent) {
  const sizes = new Map()
  const root = join(agent, 'sessions')
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const path = join(entry.parentPath, entry.name)
    sizes.set(relative(root, path), (await stat(path)).size)
  }
  return sizes
}

function routineCounts(file) {
  try {
    const out = execFileSync(
      '/usr/bin/sqlite3',
      // Read-only without -shm: Desktop has quit, so nothing writes the file now.
      [`file:${file}?immutable=1`, 'select count(*) from routines; select count(*) from runs;'],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const [routines, runs] = out.trim().split('\n').map(Number)
    return { routines, runs }
  } catch {
    return null
  }
}

const configOf = (dir) => readRecord(join(dir, 'config.json'), 64 * 1024 * 1024)

/** Desktop on the service: the CLI's view must match the plan and the sidebar's old rows. */
async function onService(ctx, report, check, expected) {
  report.onService = await launch(ctx, [], 20000)
  check(
    'second launch runs on the service',
    report.onService.mode === 'daemon' && report.onService.stayedUp,
  )
  const refusals = []
  const lanes = list(ctx, ['lane', 'list'], 'lanes', refusals)
  const archives = list(ctx, ['archive', 'list'], 'entries', refusals)
  // The sidebar folds a lane another lane was rewound from (visibleHostLanes), unless pinned.
  const folded = new Set((lanes ?? []).flatMap((l) => (l.rewoundFrom ? [l.rewoundFrom] : [])))
  report.service = {
    lanes: lanes?.length ?? null,
    shown: lanes ? lanes.filter((l) => l.pinned || !folded.has(l.laneId)).length : null,
    archives: archives?.length ?? null,
    refusals,
  }
  check('phosphor CLI lists lanes and archives', lanes !== null && archives !== null)
  // The service's own folder scan must not find lanes the move left behind.
  check(
    'service has exactly the moved lanes and archives',
    lanes?.length === expected.lanes && archives?.length === expected.archives,
  )
  return { lanes: lanes ?? [], refusals }
}

/**
 * A person restoring has lanes running: start the newest, then stop them all as they would.
 * The copy has pi's settings but not its packages, so a Claude lane refuses to start here.
 */
async function stopLanes(ctx, report, check, { lanes, refusals }) {
  const newest = lanes
    .filter((l) => l.model && !/claude/i.test(l.model.provider))
    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
  const resumed = newest ? phosphor(ctx, ['lane', 'resume', newest.laneId]).result : null
  // What the resumed lane reports while it starts, in order, without repeats.
  const seen = []
  let running = []
  for (let i = 0; i < 20 && newest; i++) {
    const now = list(ctx, ['lane', 'list'], 'lanes', refusals) ?? []
    const activity = now.find((l) => l.laneId === newest.laneId)?.activity ?? 'missing'
    if (seen.at(-1) !== activity) seen.push(activity)
    running = now.filter((lane) => lane.activity !== 'stopped')
    if (running.length) break
    await sleep(500)
  }
  report.stopped = {
    resumed: resumed?.status ?? null,
    resumedText: typeof resumed?.text === 'string' ? resumed.text.slice(0, 80) : null,
    activity: seen,
    running: running.length,
    stoppedByCli: 0,
  }
  for (const lane of running)
    if (phosphor(ctx, ['lane', 'stop', lane.laneId]).result?.status === 'ok')
      report.stopped.stoppedByCli++
  let still = running.length
  for (let i = 0; i < 40 && still > 0; i++) {
    await sleep(500)
    const now = list(ctx, ['lane', 'list'], 'lanes', refusals)
    still = now ? now.filter((lane) => lane.activity !== 'stopped').length : still
  }
  check('phosphor CLI starts and stops lanes', newest ? running.length > 0 && still === 0 : null)
}

/** The break-glass restore: exit 75 and a restart, then the backup's data exactly. */
async function restore(ctx, report, check, { migrationDir, backupDir, saved }) {
  const exitsBefore = ctx.daemon.exits.length
  report.restore = await launch(ctx, ['--restore-in-app-runtime'], 10000)
  const journal = await readRecord(join(migrationDir, 'journal.json'))
  report.restore.journal = journal?.state ?? null
  report.restore.serviceExits = ctx.daemon.exits.slice(exitsBefore)
  check('restore reverts and runs in-app', journal?.state === 'reverted')
  check('restore launch runs in-app', report.restore.mode === 'in-app' && report.restore.stayedUp)
  check('service released with exit 75 and restarted', report.restore.serviceExits.includes(75))
  const restored = restoredConfig(await configOf(ctx.roots.userData), saved)
  report.config = restored
  check('folders restored exactly', restored.folders)
  check('Claude accounts restored exactly', restored.accounts)
  report.routines = {
    backup: routineCounts(join(backupDir, 'routines.consistent.sqlite')),
    restored: routineCounts(join(ctx.roots.userData, 'routines.sqlite')),
  }
  check(
    'routines and runs restored',
    !!report.routines.backup &&
      JSON.stringify(report.routines.backup) === JSON.stringify(report.routines.restored),
  )
  return journal
}

export async function rehearseAfterCommit(ctx, migrationId, expected) {
  const { roots } = ctx
  const migrationDir = join(roots.userData, 'daemon-migration')
  const backupDir = join(migrationDir, `backup-${migrationId}`)
  const report = { checks: {} }
  /** `ok` null: the copy cannot exercise it (say, no lane it can start). */
  const check = (name, ok) => (report.checks[name] = ok === null ? 'skipped' : ok ? 'pass' : 'fail')

  await stopLanes(ctx, report, check, await onService(ctx, report, check, expected))
  const saved = await configOf(backupDir)
  const journal = await restore(ctx, report, check, { migrationDir, backupDir, saved })

  report.inApp = await launch(ctx, [], 15000)
  const after = await readRecord(join(migrationDir, 'journal.json'))
  check('next launch stays in-app', report.inApp.mode === 'in-app' && report.inApp.stayedUp)
  check('no automatic second move', JSON.stringify(after) === JSON.stringify(journal))
  const kept = restoredConfig(await configOf(roots.userData), saved)
  check('folders and accounts still there after relaunch', kept.folders && kept.accounts)
  report.sessions = sessionsKept(ctx.sessionsBefore, await transcripts(roots.agent))
  check('every conversation kept', report.sessions.kept)
  report.complete = Object.values(report.checks).every((v) => v !== 'fail')
  return report
}

export { transcripts }
