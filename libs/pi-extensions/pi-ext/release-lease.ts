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
        timeout,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
      })
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(out)
        else
          reject(new Error(`${command} ${args[0] ?? ''} failed: ${err.trim() || `exit ${code}`}`))
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input ?? '')
    })
}

export interface Lease {
  version: 1
  /** This lane: the host and session, so two lanes on one host are two holders. */
  holder: string
  host: string
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

/** Read the ref straight from origin. A missing file reads as empty. */
export async function readState(git: Run, local: string): Promise<ReleaseState> {
  if (!(await git(['ls-remote', 'origin', RELEASE_REF])).trim())
    return { sha: null, lease: null, memory: '', ledger: [] }
  await git(['fetch', '--quiet', '--no-tags', 'origin', `+${RELEASE_REF}:${local}`])
  const sha = (await git(['rev-parse', '--verify', `${local}^{commit}`])).trim()
  const file = (name: string) => git(['cat-file', 'blob', `${sha}:${name}`]).catch(() => '')
  const [lease, memory, ledger] = await Promise.all([
    file('lease.json'),
    file('memory.md'),
    file('ledger.jsonl'),
  ])
  return { sha, lease: parseLease(lease), memory, ledger: ledger.split('\n').filter(Boolean) }
}

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
    // git's lease check: the ref is no longer what this writer read. Any other
    // refusal (permissions, a server hook) is a problem to report, not a loss.
    if (/\(stale info\)/.test(String(error))) return null
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

/**
 * Acquire, renew or (with `takeover`) seize the lease. Renewal writes only
 * when the lease is older than LEASE_RENEW_MS; a refused write reads as
 * standby until the next attempt reads the ref again.
 */
export async function claimLease(
  git: Run,
  local: string,
  me: { holder: string; host: string },
  now: number,
  takeover = false,
): Promise<Claim> {
  const state = await readState(git, local)
  const lease = state.lease
  const mine = lease?.holder === me.holder
  const lapsed = !lease || Date.parse(lease.expires) <= now
  if (!mine && !lapsed && !takeover) return { role: 'standby', state }
  if (mine && !lapsed && Date.parse(lease.expires) - now > LEASE_TTL_MS - LEASE_RENEW_MS)
    return { role: 'active', state }
  const epoch = mine ? lease.epoch : (lease?.epoch ?? 0) + 1
  const next: Lease = {
    version: 1,
    ...me,
    epoch,
    expires: new Date(now + LEASE_TTL_MS).toISOString(),
  }
  const ledger = mine
    ? state.ledger
    : [
        ...state.ledger,
        ledgerEvent(
          now,
          lapsed
            ? `${me.host} took the lease (epoch ${epoch})`
            : `${me.host} took the lease over from ${lease?.host} (epoch ${epoch})`,
        ),
      ]
  const sha = await writeState(git, state.sha, { ...state, lease: next, ledger })
  return sha
    ? { role: 'active', state: { sha, lease: next, memory: state.memory, ledger } }
    : { role: 'standby', state }
}

/** True when this lane holds an unexpired lease of this epoch on origin right now. */
export async function holdsLease(
  git: Run,
  local: string,
  holder: string,
  epoch: number,
  now: number,
): Promise<boolean> {
  const { lease } = await readState(git, local)
  return lease?.holder === holder && lease.epoch === epoch && Date.parse(lease.expires) > now
}

/** Write memory or an event under a lease this lane holds; renews it on the way. */
export async function recordState(
  git: Run,
  local: string,
  holder: string,
  now: number,
  change: { memory?: string; event?: string },
): Promise<'ok' | 'not-holder'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await readState(git, local)
    const lease = state.lease
    if (lease?.holder !== holder || Date.parse(lease.expires) <= now) return 'not-holder'
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
export async function releaseLease(git: Run, local: string, holder: string, now: number) {
  const state = await readState(git, local)
  if (state.lease?.holder !== holder) return
  const lease = { ...state.lease, expires: new Date(now).toISOString() }
  const ledger = [...state.ledger, ledgerEvent(now, `${lease.host} released the lease`)]
  await writeState(git, state.sha, { ...state, lease, ledger })
}
