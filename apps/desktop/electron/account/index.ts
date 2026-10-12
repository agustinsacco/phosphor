import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type { AccountView } from '@shared/account'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { externalUrl } from '../external-links'
import { getAccountPreview, setAccountPreview } from '../store'
import { createAccount, type Account, type AccountState } from './account'
import { keychainOff, supabaseTarget } from './config'
import { createAccountControls } from './controls'
import { createGoTrue } from './gotrue'
import { createVault, safeStorageCipher, type Cipher, type Vault } from './vault'
import { accountView } from './view'

/**
 * Electron's half of the account: the real browser, keychain, userData and
 * window broadcast. Built on first use with the preview on, never at startup,
 * so a launch never reads its files and neither does Settings while it is off.
 */

let vault: Vault | null = null
let account: Account | null = null

/** The OS keychain, unless an e2e run keeps it out (see keychainOff). */
function cipher(): Cipher {
  if (!keychainOff(app.isPackaged, process.env)) {
    return safeStorageCipher(safeStorage, process.platform)
  }
  const refuse = (): never => {
    throw new Error('the keychain is off for this test run')
  }
  return {
    storage: () => ({ ok: false, reason: 'the keychain is off for this test run' }),
    encrypt: refuse,
    decrypt: refuse,
  }
}

const storage = (): ReturnType<Vault['storage']> =>
  vault?.storage() ?? { ok: false, reason: 'not checked yet' }

const view = (state: AccountState): AccountView =>
  accountView(state, getAccountPreview(), storage, () => vault?.savedMode() ?? null)

function current(): Account {
  if (account) return account
  // The target first: a bad override throws before anything is half built.
  const auth = createGoTrue(supabaseTarget(app.isPackaged, process.env))
  vault = createVault(
    join(app.getPath('userData'), 'account'),
    cipher(),
    process.platform,
    (message) => log('account', message),
  )
  const built = createAccount({
    auth,
    vault,
    // Looked up per call, not captured: e2e replaces shell.openExternal.
    openExternal: async (url) => {
      const safe = externalUrl(url)
      if (!safe) throw new Error('refused to open the sign-in address')
      await shell.openExternal(safe)
    },
    onChange: publishAccountChange,
    log: (message) => log('account', message),
  })
  account = built
  built.load()
  return built
}

const controls = createAccountControls({
  account: current,
  isBuilt: () => account !== null,
  getPreview: getAccountPreview,
  setPreview: setAccountPreview,
  view,
  publish: publishView,
})

const listeners = new Set<(view: AccountView) => void>()
export function onAccountChange(listener: (view: AccountView) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function publishView(next: AccountView): void {
  broadcast('account:changed', next)
  for (const listener of listeners) {
    try {
      listener(next)
    } catch {
      /* A subscriber cannot interrupt account delivery. */
    }
  }
}

export const accountSnapshot = (): AccountView => controls.snapshot()
export const signIn = (): AccountView => controls.signIn()
/** Turning the preview off signs out first: no session outlives its only control. */
export const setPreview = (enabled: boolean): Promise<AccountView> => controls.setPreview(enabled)

export function cancelSignIn(): void {
  // Nothing built means nothing in flight.
  account?.cancel()
}

export async function signOut(): Promise<AccountView> {
  await current().signOut()
  return accountSnapshot()
}

/**
 * Quit waits here: the sign-out shows at once, but its revocation is a request
 * still on its way, and quitting under it would leave the session alive on
 * Supabase. Capped (QUIT_WAIT_MS); nothing built means nothing to wait for.
 */
export async function settleAccount(): Promise<void> {
  if (account && !(await account.settled())) {
    log('account', 'quit before Supabase answered; a session may outlive this sign-out')
  }
}

// Non-secret epoch: a sign-out invalidates the control client account cache.
let controlGeneration = 0
export const accountControlGeneration = (): number => controlGeneration
function publishAccountChange(state: AccountState): void {
  if (state.status !== 'signed-in') controlGeneration++
  publishView(view(state))
}
export async function accountAccessToken(): Promise<string | null> {
  if (!getAccountPreview()) return null
  const account = current()
  if (account.state().status !== 'signed-in') return null
  const token = await account.accessToken()
  return getAccountPreview() && account.state().status === 'signed-in' ? token : null
}
