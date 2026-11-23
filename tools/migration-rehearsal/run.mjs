import process from 'node:process'
import console from 'node:console'
import { access, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { checkedLayout, flags } from './assert-scratch.mjs'
import {
  desktop,
  electron,
  fence,
  fixtureEnv,
  seedDaemon,
  startChild,
  supportsMigration,
} from './fixture.mjs'
import { readRecord, journalReport, readReport } from './report.mjs'

// Each run consumes exactly one successful prepare. A copied journal would be stale evidence.
async function ready(root, roots) {
  if (process.platform !== 'darwin' || process.env.CI) throw new Error('Mac operator only')
  const allowed = ['user-data', 'agent', 'before.json', 'after.json', 'prepared.json', 'host']
  const names = await readdir(root)
  if (names.length !== allowed.length || !allowed.every((n) => names.includes(n)))
    throw new Error('Not fresh')
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name),
        stat = await lstat(path)
      if (stat.isDirectory()) await walk(path)
      else if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Unexpected link or special file')
    }
  }
  await walk(root)
  const record = await readRecord(join(root, 'prepared.json'))
  if (
    record?.version !== 1 ||
    ![record.sources?.userData, record.sources?.agent].every(
      (s) => typeof s === 'string' && s.startsWith('/'),
    )
  )
    throw new Error('No source receipt')
  const journal = await lstat(join(roots.userData, 'daemon-migration', 'journal.json')).catch(
    (err) => {
      if (err.code !== 'ENOENT') throw err
    },
  )
  if (journal) throw new Error('Prior journal')
  await access(join(desktop, 'out/main/main.js'))
  await access(electron)
  return record.sources
}

async function waitDaemon(roots, id, daemon) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && daemon.running()) {
    const record = await readRecord(join(roots.state, 'local.json'))
    if (
      record?.machineId === id &&
      record.pid === daemon.pid &&
      record.socket === roots.socket &&
      (await lstat(roots.socket)).isSocket()
    )
      return
    await sleep(100)
  }
  throw new Error('Daemon did not publish scratch socket')
}

async function waitJournal(dir, start, children) {
  while (Date.now() - start < 180000 && children.every((c) => c.running())) {
    const journal = await readRecord(join(dir, 'journal.json'))
    if (
      journal?.failure ||
      ['aborted', 'reverted'].includes(journal?.state) ||
      journal?.steps?.some((s) => s.step === 'done' && s.status === 'done')
    )
      break
    await sleep(150)
  }
  return readReport(dir, start)
}

async function run(layout) {
  const { root, roots } = layout,
    sources = await ready(root, roots)
  const profile = fence(root, roots, sources),
    env = fixtureEnv(layout),
    host = join(root, 'host/phosphor.mjs')
  const start = Date.now(),
    children = []
  const stop = () => {
    for (const child of children.toReversed()) child.stop()
  }
  const interrupted = () => {
    stop()
    process.exit(1)
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  process.once('SIGHUP', interrupted)
  process.once('exit', stop)
  try {
    await mkdir(roots.home, { mode: 0o700 })
    if (!supportsMigration(profile, host, env)) {
      console.log(
        JSON.stringify({ ...journalReport(null, null, start), reason: 'host-features-missing' }),
      )
      return 1
    }
    const id = await seedDaemon(roots)
    const daemon = startChild(
      profile,
      process.execPath,
      [host, 'run', '--config', join(roots.config, 'config.json')],
      env,
    )
    children.push(daemon)
    await waitDaemon(roots, id, daemon)
    children.push(
      startChild(
        profile,
        electron,
        ['--use-mock-keychain', `--user-data-dir=${roots.userData}`, desktop],
        env,
      ),
    )
    const report = await waitJournal(join(roots.userData, 'daemon-migration'), start, children)
    console.log(JSON.stringify(report))
    return report.complete ? 0 : 1
  } finally {
    stop()
  }
}

let layout
try {
  layout = checkedLayout(flags('scratch').scratch)
} catch {
  console.error('Scratch assertion refused')
  process.exitCode = 99
}
if (layout) {
  process.umask(0o077)
  try {
    process.exitCode = await run(layout)
  } catch {
    console.error(
      'Refused: invalid inputs, sandbox, build, daemon or journal. No successful rehearsal.',
    )
    process.exitCode = 1
  }
}
