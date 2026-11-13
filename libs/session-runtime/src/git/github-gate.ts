import { GithubFailure, type GithubCommand } from './github-command'

const TTL = 60_000

/**
 * One queue and one rate-limit pause for every GitHub read on this machine.
 * Branch discovery and PR status share it, so a burst from one can never put
 * the other over GitHub's limit, and a 429 pauses both.
 */
export class GithubGate {
  private tail: Promise<unknown> = Promise.resolve()
  private blockedUntil = 0
  private hosts = new Set(['github.com'])

  constructor(private command: GithubCommand) {}

  get blocked(): boolean {
    return Date.now() < this.blockedUntil
  }

  run: GithubCommand = async (cwd, args, signal) => {
    if (signal.aborted) throw new GithubFailure('timeout')
    if (this.blocked) throw new GithubFailure('rate-limited')
    const result = await this.command(cwd, args, signal)
    if (signal.aborted) throw new GithubFailure('timeout')
    if (!result.ok && result.reason === 'rate-limited')
      this.blockedUntil = Date.now() + Math.max(TTL, result.retryAfterMs ?? TTL)
    return result
  }

  /** Runs after everything queued before it, whether that settled or failed. */
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.catch(() => undefined)
    return result
  }

  /** A GitHub Enterprise host is trusted once a checkout's origin resolved to it. */
  trustHost(host: string): void {
    if (this.hosts.size < 32) this.hosts.add(host.toLowerCase())
  }

  trusts(host: string): boolean {
    return this.hosts.has(host.toLowerCase())
  }
}
