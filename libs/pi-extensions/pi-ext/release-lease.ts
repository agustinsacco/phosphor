import { spawn } from 'node:child_process'

/**
 * One release manager per GitHub repository. The lease and the manager's
 * memory live in one orphan commit on this ref of origin, replaced by a
 * compare-and-swap push, so two hosts can never both hold it: the loser's push
 * is refused because the ref is no longer the commit it read.
 */
export const RELEASE_REF = 'refs/phosphor/release'
export const LEASE_TTL_MS = 20 * 60_000
export const LEASE_RENEW_MS = 5 * 60_000
export const MEMORY_MAX = 16_384
const LEDGER_MAX = 500
const NETWORK_MS = 90_000

export type Run = (args: string[], input?: string) => Promise<string>

/** A command whose output we read, with stdin and a deadline, never a shell. */
export function runner(command: string, cwd: string, timeout = NETWORK_MS): Run {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
      })
      const failed = (why: string) => new Error(`${command} ${args[0] ?? ''} failed: ${why}`)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeout)
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(
          error.code === 'ENOENT'
            ? new Error(`${command} is not installed, or not on PATH.`)
            : failed(error.message),
        )
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else if (timedOut) reject(failed(`no answer within ${timeout / 1000} seconds`))
        else reject(failed(err.trim() || (signal ? `stopped by ${signal}` : `exit ${code}`)))
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input ?? '')
    })
}

/** Who claims the lease: this lane's session on this host, run by this process. */
export interface Claimant {
  /** The host and session, so two lanes on one host are two holders. */
  holder: string
  host: string
  /** One session can run in two processes; only one of them holds the lease. */
  pid: number
}

export interface Lease extends Claimant {
  version: 1
  epoch: number
  expires: string
}

export interface ReleaseState {
  /** The commit read, or null when the ref does not exist. */
  sha: string | null
  lease: Lease | null
  memory: string
  ledger: string[]
}

const FILES = ['lease.json', 'ledger.jsonl', 'memory.md'] as const

function parseLease(text: string): Lease | null {
  try {
    const value = JSON.parse(text) as Partial<Lease>
    return value.version === 1 &&
      typeof value.holder === 'string' &&
      typeof value.host === 'string' &&
      Number.isSafeInteger(value.epoch) &&
      typeof value.expires === 'string' &&
      Number.isFinite(Date.parse(value.expires))
      ? (value as Lease)
      : null
  } catch {
    return null
  }
}

/**
 * Read the ref straight from origin. A file the commit lacks reads as empty;
 * a file it has but that cannot be read fails the read, so a passing glitch
 * never looks like a free lease or empty memory.
 */
export async function readState(git: Run, local: string): Promise<ReleaseState> {
  if (!(await git(['ls-remote', 'origin', RELEASE_REF])).trim())
    return { sha: null, lease: null, memory: '', ledger: [] }
  await git(['fetch', '--quiet', '--no-tags', 'origin', `+${RELEASE_REF}:${local}`])
  const sha = (await git(['rev-parse', '--verify', `${local}^{commit}`])).trim()
  const listed = new Set((await git(['ls-tree', '--name-only', sha])).split('\n'))
  const [lease, ledger, memory] = await Promise.all(
    FILES.map((name) => (listed.has(name) ? git(['cat-file', 'blob', `${sha}:${name}`]) : '')),
  )
  return {
    sha,
    lease: parseLease(lease ?? ''),
    memory: memory ?? '',
    ledger: (ledger ?? '').split('\n').filter(Boolean),
  }
}

/**
 * git's own lease check (`stale info`), or the server losing the same race
 * between its check and its update: the ref is no longer what this writer read.
 */
const LOST_RACE = /\(stale info\)|cannot lock ref|failed to update ref/

/**
 * Replace the ref only if it is still `seen`. Returns the new commit, or null
 * when another writer got there first.
 */
export async function writeState(
  git: Run,
  seen: string | null,
  next: Omit<ReleaseState, 'sha'> & { lease: Lease },
): Promise<string | null> {
  const blob = async (text: string) => (await git(['hash-object', '-w', '--stdin'], text)).trim()
  const files: Array<[string, string]> = [
    ['lease.json', `${JSON.stringify(next.lease)}\n`],
    [
      'ledger.jsonl',
      next.ledger
        .slice(-LEDGER_MAX)
        .map((line) => `${line}\n`)
        .join(''),
    ],
    ['memory.md', next.memory],
  ]
  const entries = await Promise.all(
    files.map(async ([name, text]) => `100644 blob ${await blob(text)}\t${name}\n`),
  )
  const tree = (await git(['mktree'], entries.join(''))).trim()
  const message = `release lease: ${next.lease.host} epoch ${next.lease.epoch}`
  const commit = (
    await git([
      '-c',
      'user.name=Phosphor release manager',
      '-c',
      'user.email=release-manager@phosphor.invalid',
      'commit-tree',
      // A signing key may need a touch or a passphrase, and nobody is at this terminal.
      '--no-gpg-sign',
      tree,
      '-m',
      message,
    ])
  ).trim()
  try {
    // An orphan commit replaces the old one, so the push is forced, but only
    // over the commit this writer read (or over nothing, for the first write).
    await git([
      'push',
      '--quiet',
      '--no-verify',
      `--force-with-lease=${RELEASE_REF}:${seen ?? ''}`,
      'origin',
      `${commit}:${RELEASE_REF}`,
    ])
    return commit
  } catch (error) {
    // Any other refusal (permissions, a server hook) is a problem to report, not a loss.
    if (LOST_RACE.test(String(error))) return null
    throw error
  }
}

export function ledgerEvent(now: number, text: string): string {
  return JSON.stringify({ at: new Date(now).toISOString(), text: text.slice(0, 500) })
}

export interface Claim {
  role: 'active' | 'standby'
  state: ReleaseState
}

/** No signal is sent: this only asks whether the process exists. */
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false
  try {
    process.kill(pid as number, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const held = (lease: Lease | null, me: Claimant): lease is Lease =>
  lease?.holder === me.holder && lease.pid === me.pid

/** This session's own lease, left by a process on this host that has since exited. */
const restarted = (lease: Lease | null, me: Claimant): boolean =>
  !!lease &&
  lease.holder === me.holder &&
  lease.host === me.host &&
  lease.pid !== me.pid &&
  !alive(lease.pid)

function claimEvent(lease: Lease | null, me: Claimant, now: number, epoch: number): string {
  const lapsed = !lease || Date.parse(lease.expires) <= now
  return restarted(lease, me)
    ? `${me.host} took the lease back after a restart (epoch ${epoch})`
    : lapsed
      ? `${me.host} took the lease (epoch ${epoch})`
      : `${me.host} took the lease over from ${lease.host} (epoch ${epoch})`
}

/**
 * Acquire, renew or (with `takeover`) seize the lease. Renewal writes only
 * when the lease is older than LEASE_RENEW_MS. A lost race reads origin again,
 * so the standby it returns names the lane that won.
 */
export async function claimLease(
  git: Run,
  local: string,
  me: Claimant,
  now: number,
  takeover = false,
): Promise<Claim> {
  const state = await readState(git, local)
  const lease = state.lease
  const mine = held(lease, me)
  const lapsed = !lease || Date.parse(lease.expires) <= now
  if (!mine && !lapsed && !takeover && !restarted(lease, me)) return { role: 'standby', state }
  if (mine && !lapsed && Date.parse(lease.expires) - now > LEASE_TTL_MS - LEASE_RENEW_MS)
    return { role: 'active', state }
  const epoch = mine ? lease.epoch : (state.lease?.epoch ?? 0) + 1
  const next: Lease = {
    version: 1,
    ...me,
    epoch,
    expires: new Date(now + LEASE_TTL_MS).toISOString(),
  }
  const ledger = mine
    ? state.ledger
    : [...state.ledger, ledgerEvent(now, claimEvent(lease, me, now, epoch))]
  const sha = await writeState(git, state.sha, { ...state, lease: next, ledger })
  return sha
    ? { role: 'active', state: { sha, lease: next, memory: state.memory, ledger } }
    : { role: 'standby', state: await readState(git, local) }
}

/**
 * Write memory or an event, renewing on the way, only while this process
 * holds an unexpired lease of this epoch on origin. Retries once after
 * losing a race to another write.
 */
export async function recordState(
  git: Run,
  local: string,
  me: Claimant,
  epoch: number,
  now: number,
  change: { memory?: string; event?: string },
): Promise<'ok' | 'not-holder'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await readState(git, local)
    const lease = state.lease
    if (!held(lease, me) || lease.epoch !== epoch || Date.parse(lease.expires) <= now)
      return 'not-holder'
    const next = {
      lease: { ...lease, expires: new Date(now + LEASE_TTL_MS).toISOString() },
      memory: change.memory ?? state.memory,
      ledger: change.event ? [...state.ledger, ledgerEvent(now, change.event)] : state.ledger,
    }
    if (await writeState(git, state.sha, next)) return 'ok'
  }
  return 'not-holder'
}

/** Let another host take over at once: expire this lane's lease, keep the memory. */
export async function releaseLease(git: Run, local: string, me: Claimant, now: number) {
  const state = await readState(git, local)
  if (!held(state.lease, me)) return
  const lease = { ...state.lease, expires: new Date(now).toISOString() }
  const ledger = [...state.ledger, ledgerEvent(now, `${lease.host} released the lease`)]
  await writeState(git, state.sha, { ...state, lease, ledger })
}
