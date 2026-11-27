import { createCodexUsageReader } from '@phosphor/session-runtime/pi/codex-usage'
import { authCheckArgs } from '@phosphor/session-runtime/pi/provider-auth'
import { probe } from '../machine/probe'
import type { ClaudeUsageSnapshot } from '@phosphor/shared/models'
import type { HostClaudeAccounts } from './accounts'

import { ACCOUNT_USAGE_TIMEOUT_MS } from './account-probes'
const usageError = {
  'claude-not-found': 'Claude CLI is not installed.',
  'run-failed': 'Claude usage probe failed or timed out; check this account’s CLI login.',
  'no-usage': 'No usage was reported; check this account’s subscription and CLI login.',
}

type AccountRow = { id: string; label: string } & (
  | ({ status: 'ok' } & Omit<ClaudeUsageSnapshot, 'contributing'>)
  | { status: 'unavailable'; reason: string }
)

async function accountRow(
  account: Awaited<ReturnType<HostClaudeAccounts['loadAccounts']>>['accounts'][number] | null,
  accounts: Pick<HostClaudeAccounts, 'usage' | 'accountUsageEnv'>,
  signal?: AbortSignal,
): Promise<AccountRow> {
  const row = account
    ? { id: account.id, label: account.label }
    : { id: 'default', label: 'Default Claude login' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const unavailable = (reason: string): AccountRow => ({ ...row, status: 'unavailable', reason })
  if (signal?.aborted) return unavailable('Usage probe cancelled.')
  try {
    const result = await Promise.race([
      new Promise<'timeout' | 'cancelled'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ACCOUNT_USAGE_TIMEOUT_MS)
        abort = () => resolve('cancelled')
        signal?.addEventListener('abort', abort, { once: true })
      }),
      accounts.usage.fetchUsageSnapshot(
        account ? { cacheKey: account.id, extraEnv: accounts.accountUsageEnv(account) } : undefined,
      ),
    ])
    if (result === 'timeout')
      return unavailable(`Usage probe timed out after ${ACCOUNT_USAGE_TIMEOUT_MS / 1000}s.`)
    if (result === 'cancelled') return unavailable('Usage probe cancelled.')
    if (!result.ok) return unavailable(usageError[result.error])
    const { windows, fetchedAt, stale } = result.snapshot
    return { ...row, status: 'ok', windows, fetchedAt, stale }
  } catch {
    return unavailable('Could not probe this Claude account; check Host settings.')
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

export async function usageAccounts(
  accounts: Pick<HostClaudeAccounts, 'readMetadata' | 'usage' | 'accountUsageEnv'>,
  signal?: AbortSignal,
): Promise<AccountRow[]> {
  const prefs = accounts.readMetadata()
  return Promise.all(
    (prefs.accounts.length ? prefs.accounts : [null]).map((account) =>
      accountRow(account, accounts, signal),
    ),
  )
}

/** Private, no-refresh auth for the shared usage reader; never forward raw probe output. */
export function hostCodexUsage(
  pi: { binaryPath: string; prefixArgs: readonly string[] },
  env: Record<string, string>,
) {
  return createCodexUsageReader(async () => {
    const run = await probe(
      pi.binaryPath,
      [...pi.prefixArgs, ...authCheckArgs('openai-codex', { credentials: true })],
      {
        env,
        secrets: [],
        timeoutMs: 8_000,
      },
    )
    return !run.truncated && run.code === 0 ? run.stdout : ''
  })
}
