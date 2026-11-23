import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'

// Never pass data-controlled messages, keys, paths or session contents through to stdout.
const states = ['running', 'aborted', 'commit-requested', 'committed', 'consented', 'reverted']
const steps = [
  'preflight',
  'backup',
  'plan',
  'begin',
  'folders',
  'policy',
  'accounts',
  'lanes',
  'marks',
  'archives',
  'artifacts',
  'routines',
  'verify',
  'commit-request',
  'commit',
  'device',
  'quarantine',
  'done',
]
const gates = ['G10', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G11']
const counts = ['folders', 'lanes', 'pins', 'markers', 'archives', 'accounts', 'routines', 'runs']
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

/** Atomic journal and plan; reject links, multiply-linked and oversized files before parsing. */
export async function readRecord(path, limit = 1024 * 1024) {
  try {
    if ((await realpath(path)) !== path) throw new Error('Linked record')
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await f.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
        throw new Error('Unexpected record')
      return JSON.parse(await f.readFile('utf8'))
    } finally {
      await f.close()
    }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function journalReport(journal, plan, start) {
  const state = states.includes(journal?.state) ? journal.state : 'none'
  const done = (name) => journal?.steps?.some((s) => s.step === name && s.status === 'done')
  const failureStep = steps.includes(journal?.failure?.step) ? journal.failure.step : null
  const failed = gates.find((g) => journal?.failure?.code === `gate-${g.toLowerCase()}`)
  const gateResults = Object.fromEntries(
    gates.map((g) => [g, done('verify') ? 'pass' : g === failed ? 'fail' : 'unverified']),
  )
  const expected = Object.fromEntries(
    counts
      .filter((k) => Number.isSafeInteger(plan?.expected?.[k]) && plan.expected[k] >= 0)
      .map((k) => [k, plan.expected[k]]),
  )
  const elapsedMs = Date.now() - start
  let last = Date.parse(journal?.startedAt)
  const stepMs = {}
  for (const name of steps) {
    const at = Date.parse(journal?.steps?.find((s) => s.step === name)?.at)
    if (Number.isFinite(at) && at >= last) {
      stepMs[name] = at - last
      last = at
    }
  }
  return {
    state,
    failureStep,
    gateResults,
    expected,
    elapsedMs,
    stepMs,
    complete:
      state === 'committed' &&
      !journal.failure &&
      ['verify', 'device', 'quarantine', 'done'].every(done),
  }
}

export async function readReport(dir, start) {
  const journal = await readRecord(join(dir, 'journal.json'))
  if (journal && (!uuid.test(journal.migrationId) || !states.includes(journal.state)))
    throw new Error('Invalid journal')
  const plan = journal
    ? await readRecord(join(dir, `backup-${journal.migrationId}`, 'plan.json'), 64 * 1024 * 1024)
    : null
  return journalReport(journal, plan, start)
}
