/**
 * Several Claude Code logins side by side, and the routing over them.
 *
 * The CLI keeps one credential — but *which* one it keeps is a function of a
 * directory. From its own bundle (2.1.260):
 *
 *     var t5 = "-credentials"
 *     function fx(n = "") {
 *       let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
 *           t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR,
 *           r = e !== undefined ? e.normalize("NFC") : configDir(),
 *           c = t ? "" : `-${sha256(r).slice(0, 8)}`
 *       return `Claude Code${SUFFIX}${n}${c}`
 *     }
 *
 * So `CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir>` moves the keychain entry to
 * `Claude Code-credentials-<hash of dir>` and nothing else moves with it —
 * `claude auth status` under an isolated dir still reports
 * `projectsDirectory: ~/.claude/projects`. `CLAUDE_CONFIG_DIR` is the wrong
 * knob for this: it relocates projects, settings.json, skills and plugins too.
 *
 * Phosphor spawns one `pi` per session and pi-claude-cli spawns the CLI with
 * `{ ...process.env }`, so putting the variable on the pi spawn binds the whole
 * session — pi, the extension, and the parked CLI process — to one account.
 * That is why this feature needs no pi-claude-cli change at all.
 *
 * The first account is seeded with `credentialDir: null`, i.e. the CLI's own
 * default entry. Nothing migrates, and your terminal `claude` keeps sharing it.
 */
import type { ClaudeAccountPorts } from './account-ports'
import { createAccountState } from './account-state'
import { createAccountLifecycle } from './account-lifecycle'
import { createAccountRouting } from './account-routing'
import { createAccountUsage } from './account-usage'

export { claudeAccountEnv } from './routing'
export type { ClaudeAccountPorts } from './account-ports'

/** One mutation queue per machine, without holding startup behind usage probes. */
function createMutationQueue() {
  let mutations = Promise.resolve()
  return function serialized<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R> => {
      const pending = mutations.then(() => fn(...args))
      mutations = pending.then(
        () => {},
        () => {},
      )
      return pending
    }
  }
}

/** One account domain per execution machine. Credentials never leave the CLI's store. */
export function createClaudeAccounts(ports: ClaudeAccountPorts) {
  const state = createAccountState(ports)
  const usage = createAccountUsage(state)
  const lifecycle = createAccountLifecycle(state)
  const routing = createAccountRouting(state, usage.refreshCooldowns)
  // Two concurrent starts must not select the same round-robin cursor.
  const serialized = createMutationQueue()
  return {
    accountUsageEnv: usage.accountUsageEnv,
    loadAccounts: state.loadAccounts,
    primaryAccount: routing.primaryAccount,
    accountForSpawn: serialized(routing.accountForSpawn),
    bindSession: serialized(routing.bindSession),
    refreshCooldowns: usage.refreshCooldowns,
    accountViews: usage.accountViews,
    beginAddAccount: serialized(lifecycle.beginAddAccount),
    finishAddAccount: serialized(lifecycle.finishAddAccount),
    removeAccount: serialized(lifecycle.removeAccount),
    reorderAccounts: serialized(lifecycle.reorderAccounts),
    setRouting: serialized(routing.setRouting),
    holdAccount: serialized(routing.holdAccount),
    sessionAccount: routing.sessionAccount,
  }
}
