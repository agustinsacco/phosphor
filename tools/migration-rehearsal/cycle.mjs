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

export async function rehearseAfterCommit(ctx, migrationId) {
  const { roots } = ctx
  const migrationDir = join(roots.userData, 'daemon-migration')
  const backupDir = join(migrationDir, `backup-${migrationId}`)
  const sessionsBefore = ctx.sessionsBefore
  const report = { checks: {} }
  const check = (name, ok) => (report.checks[name] = ok ? 'pass' : 'fail')

  report.onService = await launch(ctx, [], 20000)
  check(
    'second launch runs on the service',
    report.onService.mode === 'daemon' && report.onService.stayedUp,
  )
  const refusals = []
  const lanes = list(ctx, ['lane', 'list'], 'lanes', refusals)
  const archives = list(ctx, ['archive', 'list'], 'entries', refusals)
  report.service = { lanes: lanes?.length ?? null, archives: archives?.length ?? null, refusals }
  check('phosphor CLI lists lanes and archives', lanes !== null && archives !== null)

  const running = (lanes ?? []).filter((lane) => lane.activity !== 'stopped')
  report.stopped = { running: running.length, stoppedByCli: 0 }
  for (const lane of running)
    if (phosphor(ctx, ['lane', 'stop', lane.laneId]).result?.status === 'ok')
      report.stopped.stoppedByCli++

  const exitsBefore = ctx.daemon.exits.length
  report.restore = await launch(ctx, ['--restore-in-app-runtime'], 10000)
  const journal = await readRecord(join(migrationDir, 'journal.json'))
  report.restore.journal = journal?.state ?? null
  report.restore.serviceExits = ctx.daemon.exits.slice(exitsBefore)
  check('restore reverts and runs in-app', journal?.state === 'reverted')
  check('restore launch runs in-app', report.restore.mode === 'in-app' && report.restore.stayedUp)
  check('service released with exit 75 and restarted', report.restore.serviceExits.includes(75))

  const saved = await configOf(backupDir)
  const restored = restoredConfig(await configOf(roots.userData), saved)
  report.config = restored
  check('folders restored exactly', restored.folders)
  check('Claude accounts restored exactly', restored.accounts)
  const routinesFile = join(roots.userData, 'routines.sqlite')
  report.routines = {
    backup: routineCounts(join(backupDir, 'routines.consistent.sqlite')),
    restored: routineCounts(routinesFile),
  }
  check(
    'routines and runs restored',
    !!report.routines.backup &&
      JSON.stringify(report.routines.backup) === JSON.stringify(report.routines.restored),
  )

  report.inApp = await launch(ctx, [], 15000)
  const after = await readRecord(join(migrationDir, 'journal.json'))
  check('next launch stays in-app', report.inApp.mode === 'in-app' && report.inApp.stayedUp)
  check('no automatic second move', JSON.stringify(after) === JSON.stringify(journal))
  const kept = restoredConfig(await configOf(roots.userData), saved)
  check('folders and accounts still there after relaunch', kept.folders && kept.accounts)
  report.sessions = sessionsKept(sessionsBefore, await transcripts(roots.agent))
  check('every conversation kept', report.sessions.kept)
  report.complete = Object.values(report.checks).every((v) => v === 'pass')
  return report
}

export { transcripts }
