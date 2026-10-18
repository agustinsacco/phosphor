import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap, ControlResult } from '../ipc'
import type { AccountView } from '../account'
import type {
  MachinesResponse,
  EnrollmentLookupResponse,
  EnrollmentApproveResponse,
} from '../control-api'
import type {
  ClaudeAccountSessions,
  ClaudeAccountsResult,
  ClaudeSessionAccount,
  ClaudeRoutingMode,
  ClaudeUsageSnapshotResult,
} from '../models'
export interface BaselineClaudeInvokeMap {
  /**
   * Sign the Claude Code CLI in from inside Phosphor — the account that bills a
   * Claude Pro/Max plan.
   *
   * No terminal, and no pty either: unlike pi's TUI-only `/login`,
   * `claude auth login` accepts piped stdio, so `electron/pi/claude-login.ts`
   * reads its URL off stdout and writes the pasted code back into stdin.
   * Resolves once the CLI is running; progress arrives on `claude:loginState`,
   * because the middle of it is a human in a browser. The CLI opens the browser
   * itself, so main deliberately does not.
   *
   * With no argument this adds a NEW account, in its own keychain entry. Pass
   * an existing account id to re-authenticate that one in place.
   */
  'claude:startLogin': { args: [accountId?: string]; result: void }

  /** Hand the code copied from the authorization page to the waiting CLI. */
  'claude:submitCode': { args: [code: string]; result: void }

  /** Abort a `claude:startLogin` in progress. No-op if nothing is running. */
  'claude:cancelLogin': { args: []; result: void }

  /** `claude auth logout`. Credentials are the CLI's, so this is its subcommand. */
  'claude:logout': { args: []; result: void }

  /**
   * Every Claude login Phosphor knows about, in routing order, with each one's
   * live auth state and cached usage.
   *
   * Multiple accounts are possible because `CLAUDE_SECURESTORAGE_CONFIG_DIR`
   * moves the CLI's keychain entry without moving `~/.claude` with it. One
   * `claude auth status` per account, in parallel; usage is only ever read
   * from main's cache here, never fetched inline.
   */
  'claude:accounts': { args: []; result: ClaudeAccountsResult }

  /** Sign an account out and drop it from the list. */
  'claude:removeAccount': { args: [accountId: string]; result: void }

  /** Persist the account order — `ordered` mode walks it top to bottom. */
  'claude:reorderAccounts': { args: [ids: string[]]; result: void }

  /** Set the routing rule, and which account `specific` points at. */
  'claude:setRouting': {
    args: [mode: ClaudeRoutingMode, pinnedId?: string]
    result: void
  }

  /**
   * Re-read `/usage` for every account and recompute cooldowns.
   *
   * One zero-quota CLI run per account. The routing path never waits on this;
   * it is what the settings tab calls, and what a session start kicks off in
   * the background so the NEXT session routes on fresh numbers.
   */
  'claude:refreshAccountUsage': { args: []; result: ClaudeAccountsResult }

  /**
   * Bind a session file to the account that spawned it.
   *
   * Called by the renderer once `get_state` reveals the path — main chooses the
   * account at spawn time, but a brand-new session has no file yet. Without the
   * binding, resuming a round-robin session could land on a different plan,
   * which misses the entire prompt cache and splits the thread's cost in two.
   */
  'claude:bindSession': { args: [sessionPath: string, phosphorSessionId: string]; result: void }

  /**
   * Point a session file at an account by hand, for the next spawn.
   *
   * The lane the user is looking at cannot move: its credential is fixed by
   * the environment pi was spawned with. So "move this lane" is this call plus
   * a dispose-and-resume in the renderer, which is why main only writes the
   * binding here and never touches the subprocess.
   */
  'claude:assignSession': { args: [sessionPath: string, accountId: string]; result: void }

  /** Account id → the live Phosphor sessions spawned onto it. */
  'claude:accountSessions': { args: []; result: ClaudeAccountSessions }

  /**
   * Which account bills a session: the pick parked at spawn, else the stored
   * binding for its file. Null when no account is configured, when the session
   * is not on the Claude provider, or when neither source knows it yet.
   */
  'claude:sessionAccount': {
    args: [phosphorSessionId: string, sessionPath?: string]
    result: ClaudeSessionAccount | null
  }

  /**
   * Live subscription usage — the numbers Claude Code's own `/usage` panel
   * shows (5-hour + weekly windows, with percents), read by spawning
   * `claude -p /usage` (zero model calls, zero quota) in main and parsing
   * its rendered text. Works for every signed-in subscription account; no
   * API key, no org, no credential crosses into Phosphor. Cached ~60 s in main,
   * because the endpoint behind it rate-limits.
   *
   * `force` skips that cache for a user-initiated refresh — the only caller
   * that may, and only because someone clicked. Concurrent forces still share
   * one CLI run, so a double click cannot spawn two.
   */
  'claude:usageSnapshot': {
    args: [accountId?: string, force?: boolean]
    result: ClaudeUsageSnapshotResult
  }
}
export interface BaselineAccountInvokeMap {
  /**
   * Desktop's optional Phosphor sign-in in the sidebar footer. Main owns the session; these
   * carry no token and no account id. See `electron/account/`.
   */
  'account:get': { args: []; result: AccountView }

  /** Opens the browser and resolves at once; the outcome arrives on `account:changed`. */
  'account:signIn': { args: []; result: AccountView }

  'account:cancelSignIn': { args: []; result: void }

  /** Signs out here even when Supabase cannot be told. */
  'account:signOut': { args: []; result: AccountView }
}
export interface BaselineControlInvokeMap {
  /** Main-only control traffic. Arguments and responses use the control-api parsers. */
  'control:machines': { args: []; result: ControlResult<MachinesResponse> }

  'control:lookupEnrollment': {
    args: [code: string]
    result: ControlResult<EnrollmentLookupResponse>
  }

  'control:approveEnrollment': {
    args: [code: string, label: string]
    result: ControlResult<EnrollmentApproveResponse>
  }

  'control:renameMachine': {
    args: [id: string, label: string]
    result: ControlResult<EnrollmentApproveResponse>
  }

  'control:removeMachine': { args: [id: string]; result: ControlResult<Record<never, never>> }
}
it('freezes claude, account, control channel tuples and results through ipc.ts', () => {
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineClaudeInvokeMap>
  >().toEqualTypeOf<BaselineClaudeInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineAccountInvokeMap>
  >().toEqualTypeOf<BaselineAccountInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineControlInvokeMap>
  >().toEqualTypeOf<BaselineControlInvokeMap>()
})

import type { ClaudeInvokeMap, AccountInvokeMap, ControlInvokeMap } from './auth'

it('keeps claude leaf exact and confined to its prefix', () => {
  expectTypeOf<ClaudeInvokeMap>().toEqualTypeOf<BaselineClaudeInvokeMap>()
  expectTypeOf<keyof ClaudeInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `claude:${string}`>
  >()
})

it('keeps account leaf exact and confined to its prefix', () => {
  expectTypeOf<AccountInvokeMap>().toEqualTypeOf<BaselineAccountInvokeMap>()
  expectTypeOf<keyof AccountInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `account:${string}`>
  >()
})

it('keeps control leaf exact and confined to its prefix', () => {
  expectTypeOf<ControlInvokeMap>().toEqualTypeOf<BaselineControlInvokeMap>()
  expectTypeOf<keyof ControlInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `control:${string}`>
  >()
})
