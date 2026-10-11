import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type { AccountView } from '@shared/account'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { externalUrl } from '../external-links'
import { getAccountPreview, setAccountPreview } from '../store'
import { createAccount, type Account, type AccountState } from './account'
import { keychainOff, supabaseTarget } from './config'
import { createGoTrue } from './gotrue'
import { createVault, safeStorageCipher, type Cipher, type Vault } from './vault'
import { accountView } from './view'

/**
 * Electron's half of the account: the real browser, keychain, userData and
 * window broadcast. Built on first use, never at startup, so a launch that
 * never opens Settings → Accounts never reads the file either.
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

const view = (state: AccountState): AccountView => accountView(state, getAccountPreview(), storage)

function current(): Account {
  if (account) return account
  vault = createVault(join(app.getPath('userData'), 'account'), cipher())
  const built = createAccount({
    auth: createGoTrue(supabaseTarget(app.isPackaged, process.env)),
    vault,
    // Looked up per call, not captured: e2e replaces shell.openExternal.
    openExternal: async (url) => {
      const safe = externalUrl(url)
      if (!safe) throw new Error('refused to open the sign-in address')
      await shell.openExternal(safe)
    },
    onChange: (state) => broadcast('account:changed', view(state)),
    log: (message) => log('account', message),
  })
  account = built
  built.load()
  return built
}

export function accountSnapshot(): AccountView {
  return view(current().state())
}

export function signIn(): AccountView {
  if (!getAccountPreview()) {
    throw new Error('Phosphor sign-in is a preview: turn it on in Settings → Advanced.')
  }
  // Resolves when the browser comes back; windows hear the outcome on account:changed.
  void current().signIn()
  return accountSnapshot()
}

export function cancelSignIn(): void {
  current().cancel()
}

export async function signOut(): Promise<AccountView> {
  await current().signOut()
  return accountSnapshot()
}

/** Turning the preview off signs out first: no session outlives its only control. */
export async function setPreview(enabled: boolean): Promise<AccountView> {
  if (!enabled) await current().signOut()
  setAccountPreview(enabled)
  const next = accountSnapshot()
  broadcast('account:changed', next)
  return next
}
