import { useEffect, useRef, useState } from 'react'
import type { AccountProfileView } from '@shared/account'
import { ipcErrorText } from '@shared/errors'
import { PopupMenu } from '@/components/PopupMenu'
import { GearIcon, Spinner, UserIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { useAccount } from '@/features/settings/useAccount'
import { formatShortcut } from '@/lib/shortcuts'
import { useNavigation } from '@/navigation/Navigation'
import { locationMachine } from '@/navigation/location'
import { usePlatform } from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'

export function avatarInitials(user?: AccountProfileView): string {
  const words = (user?.name ?? user?.login ?? '?').trim().split(/\s+/)
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

export function AccountAvatar({
  user,
  large = false,
}: {
  user?: AccountProfileView
  large?: boolean
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [user?.avatarDataUrl])
  const colours = [
    'bg-accent-soft text-accent',
    'bg-success/15 text-success',
    'bg-info/15 text-info',
  ]
  const hash = [...(user?.login ?? user?.name ?? '')].reduce((sum, c) => sum + c.charCodeAt(0), 0)
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium ${large ? 'h-10 w-10 text-lg' : 'h-7 w-7 text-base'} ${user ? colours[hash % colours.length] : 'bg-chip text-text-secondary'}`}
    >
      {user?.avatarDataUrl?.startsWith('data:image/') && !failed ? (
        <img
          alt=""
          className="h-full w-full object-cover"
          src={user.avatarDataUrl}
          onError={() => setFailed(true)}
        />
      ) : user ? (
        avatarInitials(user)
      ) : (
        <UserIcon size={large ? 18 : 14} />
      )}
    </span>
  )
}

export function AccountFooter(): React.JSX.Element {
  const { view, error: loadError } = useAccount()
  const { location, navigate } = useNavigation()
  // Only a client that installs the app shortcuts advertises one.
  const shortcut = usePlatform().appShortcuts ? formatShortcut('mod', ',') : null
  const account = view?.account ?? { status: 'signed-out' }
  const user = account.status === 'signed-in' ? account.user : undefined
  const online = useMachinesStore(
    (s) => Object.values(s.statuses).filter((status) => status === 'up').length,
  )
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  useEffect(() => {
    if (open) menu.current?.querySelector('button')?.focus()
  }, [open])
  useEffect(() => setOpen(false), [account.status])
  const run = (channel: 'account:signIn' | 'account:signOut' | 'account:cancelSignIn'): void => {
    setError(null)
    void window.phosphor.invoke(channel).catch((caught: unknown) => setError(ipcErrorText(caught)))
  }
  const settings = (): void => {
    close()
    navigate({ to: 'page', page: 'settings', machine: locationMachine(location) })
  }
  const item =
    'hover:bg-bg-secondary flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-lg'
  return (
    <div className="relative" data-testid="account-footer">
      {open && account.status !== 'signing-in' && (
        <PopupMenu
          triggerRef={trigger}
          onClose={close}
          className="absolute bottom-full left-0 mb-3 w-72 p-1.5"
          ariaLabel="Account"
        >
          <div
            ref={menu}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const buttons = Array.from(menu.current?.querySelectorAll('button') ?? [])
              const index = buttons.findIndex((button) => button === document.activeElement)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
              event.preventDefault()
              buttons[next]?.focus()
            }}
          >
            {user ? (
              <div className="border-border mb-1 flex items-center gap-3 border-b px-3 pb-4 pt-3">
                <AccountAvatar user={user} large />
                <div className="min-w-0">
                  <p className="truncate text-lg font-medium">
                    {user.name ?? `@${user.login ?? 'account'}`}
                  </p>
                  <p className="text-text-secondary text-base">{user.login && `@${user.login}`}</p>
                  <p className="text-text-secondary truncate text-sm">{user.email}</p>
                </div>
              </div>
            ) : (
              <div className="px-3 py-3">
                <p className="text-lg font-medium">Your Phosphor account</p>
                <p className="text-text-secondary mt-1 text-base">
                  Sign-in is optional. Add other machines while everything here stays local.
                </p>
              </div>
            )}
            {user ? (
              <TooltipButton
                className={item}
                onClick={() => {
                  close()
                  useMachinesStore.getState().show({ kind: 'list' })
                }}
              >
                Machines <span className="text-text-secondary text-base">{online} online</span>
              </TooltipButton>
            ) : (
              <TooltipButton
                className={item}
                onClick={() => {
                  close()
                  run('account:signIn')
                }}
              >
                Sign in with GitHub
              </TooltipButton>
            )}
            <TooltipButton className={item} onClick={settings}>
              Settings{' '}
              {shortcut && <span className="text-text-tertiary text-base">{shortcut}</span>}
            </TooltipButton>
            {user && (
              <div className="border-border mt-1 border-t pt-1">
                <TooltipButton
                  className={`${item} text-danger`}
                  onClick={() => {
                    close()
                    run('account:signOut')
                  }}
                >
                  Sign out
                </TooltipButton>
              </div>
            )}
          </div>
        </PopupMenu>
      )}
      <div className="flex items-center gap-1">
        {account.status === 'signing-in' ? (
          <SigningIn onCancel={() => run('account:cancelSignIn')} />
        ) : (
          <TooltipButton
            ref={trigger}
            aria-expanded={open}
            aria-label={user ? 'Your account' : 'Sign in'}
            onClick={() => setOpen(!open)}
            className="hover:bg-sidebar-hover flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-2 text-left"
          >
            <AccountAvatar user={user} />
            <span className="min-w-0">
              <span className="block truncate text-lg font-medium">
                {user ? (user.name ?? `@${user.login ?? 'account'}`) : 'Sign in'}
              </span>
              {user?.login && (
                <span className="text-text-secondary block truncate text-sm">@{user.login}</span>
              )}
            </span>
          </TooltipButton>
        )}
        <TooltipButton
          aria-label="Settings"
          title={shortcut ? `Settings (${shortcut})` : 'Settings'}
          onClick={settings}
          className="text-text-secondary hover:bg-sidebar-hover hover:text-text flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
        >
          <GearIcon />
        </TooltipButton>
      </div>
      {(error ?? loadError ?? (account.status === 'signed-out' ? account.error : undefined)) && (
        <p role="alert" className="text-danger px-1.5 text-sm">
          {error ?? loadError ?? (account.status === 'signed-out' ? account.error : '')}
        </p>
      )}
    </div>
  )
}

/** A sign-in finishing in the system browser; Cancel only where this client can cancel it. */
function SigningIn({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  const { cancelSignIn } = usePlatform()
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-2 text-base">
      <Spinner />
      <span className="min-w-0">Finish in your browser…</span>
      {cancelSignIn && (
        <TooltipButton className="text-text-secondary ml-auto" onClick={onCancel}>
          Cancel
        </TooltipButton>
      )}
    </div>
  )
}
