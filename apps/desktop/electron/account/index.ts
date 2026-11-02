import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type { AccountView } from '@shared/account'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { externalUrl } from '../external-links'
import { createAccount, type Account, type AccountState } from './account'
import { keychainOff, supabaseTarget } from './config'
import { createAccountControls } from './controls'
import { createGoTrue } from './gotrue'
import { createVault, safeStorageCipher, type Cipher, type Vault } from './vault'
import { accountView } from './view'
import { createAvatarCache, fetchAvatar } from './avatar'

/**
 * Electron's half of the account: the real browser, keychain, userData and
 * window broadcast. Loads the plain profile at launch without network or keychain access.
 */

let vault: Vault | null = null
let account: Account | null = null
let avatar: string | null = null
let avatarIdentity: string | null = null
let avatarGeneration = 0
let avatarCache: ReturnType<typeof createAvatarCache> | null = null

/** The OS keychain, unless an e2e run keeps it out (see keychainOff). */
function cipher(): Cipher {
  if (!keychainOff(app.isPackaged, process.env)) {
    return safeStorageCipher(safeStorage, process.platform)
  }
  const refuse = (): Promise<never> =>
    Promise.reject(new Error('the keychain is off for this test run'))
  return {
    storage: async () => ({ ok: false, reason: 'the keychain is off for this test run' }),
    encrypt: refuse,
    decrypt: refuse,
  }
}

const storage = (): ReturnType<Vault['storage']> =>
  vault?.storage() ?? { ok: false, reason: 'not checked yet' }

const view = (state: AccountState): AccountView => {
  const next = accountView(state, storage, () => vault?.savedMode() ?? null)
  if (next.account.status === 'signed-in' && avatar) {
    return { account: { ...next.account, user: { ...next.account.user, avatarDataUrl: avatar } } }
  }
  return next
}

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
  avatarCache = createAvatarCache(join(app.getPath('userData'), 'account'))
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
  view,
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
  if (state.status !== 'signed-in') {
    controlGeneration++
    avatarGeneration++
    avatar = null
    avatarIdentity = null
  } else {
    const identity = `${state.user.id}:${state.user.avatarUrl ?? ''}`
    if (identity !== avatarIdentity) {
      avatarIdentity = identity
      const source = state.user.avatarUrl
      avatar = source ? (avatarCache?.read(state.user.id, source) ?? null) : null
      const generation = ++avatarGeneration
      // The cache shows a face at once; GitHub keeps the URL when the picture
      // changes, so each sign-in and launch still fetches once to refresh it.
      if (source)
        void fetchAvatar(source).then((image) => {
          if (!image || generation !== avatarGeneration || image === avatar) return
          avatar = image
          try {
            avatarCache?.save(state.user.id, source, image)
          } catch {
            /* Initials remain available. */
          }
          publishView(view(account?.state() ?? state))
        })
    }
  }
  publishView(view(state))
}
export async function accountAccessToken(): Promise<string | null> {
  const account = current()
  if (account.state().status !== 'signed-in') return null
  const token = await account.accessToken()
  return account.state().status === 'signed-in' ? token : null
}

/** Main-only identity. The renderer account view intentionally omits this id. */
export function accountUserId(): string | null {
  const state = current().state()
  return state.status === 'signed-in' ? state.user.id : null
}
