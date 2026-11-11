import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { stripAnsi } from '@shared/ansi'
import { TooltipButton } from '@/components/Tooltip'
import { CheckIcon, CloseIcon } from '@/components/icons'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { absoluteTime, relativeTimeShort } from '@/lib/time'
import {
  NEW_TTL_MS,
  SEEN_TTL_MS,
  useNotificationsStore,
  type Notification,
} from '@/stores/notifications'
import { NoticeGlyph } from './NoticeGlyph'
import { setNotificationsOpen } from './NotificationsButton'

const HOURS = 60 * 60 * 1000

/**
 * The notification drawer: the left navigation's twin on the right. Same
 * ground, same mono section labels, same row rhythm, so it reads as part of
 * the shell rather than a popover. New notices sit under New in the accent;
 * once seen they drop to Earlier in the muted tone until they age out.
 */
export function NotificationDrawer(): React.JSX.Element {
  const items = useNotificationsStore((s) => s.items)
  // Re-render each minute so "4m ago" keeps up while the drawer stays open.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000)
    return () => clearInterval(timer)
  }, [])
  const fresh = items.filter((item) => !item.seenAt)
  const seen = items.filter((item) => item.seenAt)
  const { markSeen, clearSeen } = useNotificationsStore.getState()
  return (
    <aside
      aria-label="Notifications"
      data-testid="notification-drawer"
      className="bg-sidebar border-border flex h-full w-[var(--px-drawer-width)] shrink-0 flex-col border-l"
    >
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span className="text-text text-lg font-medium">Notifications</span>
        {fresh.length > 0 && (
          <span className="bg-accent-soft text-accent rounded px-1 py-px text-xs tabular-nums">
            {fresh.length} new
          </span>
        )}
        <span className="flex-1" />
        {fresh.length > 0 && (
          <DrawerButton label="Mark all seen" onClick={() => markSeen()}>
            <CheckIcon size={12} />
          </DrawerButton>
        )}
        <DrawerButton label="Close notifications" onClick={() => setNotificationsOpen(false)}>
          <CloseIcon size={11} strokeWidth={2.5} />
        </DrawerButton>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {items.length === 0 && (
          <p className="text-text-tertiary px-2 pt-6 text-center text-sm">
            Nothing yet. Lane updates and problems land here.
          </p>
        )}
        {fresh.length > 0 && <SectionLabel>New</SectionLabel>}
        <NotificationList items={fresh} />
        {seen.length > 0 && (
          <div className="flex items-center pr-1">
            <SectionLabel>Earlier</SectionLabel>
            <TooltipButton
              onClick={clearSeen}
              className="text-text-tertiary hover:text-text ml-auto pt-2.5 text-xs"
            >
              Clear
            </TooltipButton>
          </div>
        )}
        <NotificationList items={seen} />
      </div>
      <p className="border-border text-text-tertiary border-t px-3 py-2 text-xs">
        Seen notices clear after {SEEN_TTL_MS / HOURS}h, new ones after {NEW_TTL_MS / HOURS}h.
      </p>
    </aside>
  )
}

function NotificationList({ items }: { items: Notification[] }): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ol className="flex flex-col gap-px">
      {items.map((item) => (
        <NotificationRow key={item.id} item={item} />
      ))}
    </ol>
  )
}

/** One notice as a sidebar-style row: marker, title and time, then its line. */
function NotificationRow({ item }: { item: Notification }): React.JSX.Element {
  const isNew = !item.seenAt
  const { markSeen, remove } = useNotificationsStore.getState()
  const open = (): void => {
    markSeen([item.id])
    void Promise.resolve(item.onOpen?.()).catch(() => undefined)
  }
  const heading = item.title ?? stripAnsi(item.message)
  return (
    <li
      data-testid="notification-row"
      data-seen={isNew ? undefined : ''}
      data-kind={item.kind}
      className="group relative flex items-start"
    >
      <TooltipButton
        onClick={open}
        aria-label={item.openLabel ? `${item.openLabel}: ${heading}` : heading}
        className={clsx(
          'flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors',
          isNew
            ? 'hover:bg-sidebar-hover bg-[color-mix(in_srgb,var(--px-accent)_7%,transparent)]'
            : 'hover:bg-sidebar-hover',
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <span
            className={clsx(
              'h-2 w-2 rounded-full',
              isNew ? 'bg-accent' : 'border-border-strong border',
            )}
            data-tooltip={isNew ? 'New' : 'Seen'}
          />
        </span>
        <NoticeGlyph toast={item} ground="bg-sidebar" />
        <span className="min-w-0 flex-1 pl-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={clsx(
                'min-w-0 flex-1 truncate text-base font-medium leading-5',
                isNew ? 'text-text' : 'text-text-secondary',
              )}
            >
              {heading}
            </span>
            <time
              dateTime={new Date(item.at).toISOString()}
              data-tooltip={absoluteTime(item.at)}
              className="text-text-tertiary shrink-0 text-xs tabular-nums group-hover:invisible"
            >
              {relativeTimeShort(item.at)}
            </time>
          </span>
          {item.title && (
            <span
              className={clsx(
                'line-clamp-2 text-sm leading-4 break-words',
                item.kind === 'error'
                  ? 'text-danger'
                  : isNew
                    ? 'text-text-secondary'
                    : 'text-text-tertiary',
              )}
            >
              {stripAnsi(item.message)}
            </span>
          )}
        </span>
      </TooltipButton>
      <TooltipButton
        onClick={() => remove(item.id)}
        aria-label="Remove notification"
        className="text-text-tertiary hover:text-text absolute right-1 top-1.5 hidden p-1 group-hover:block focus-visible:block"
      >
        <CloseIcon size={10} strokeWidth={2.5} />
      </TooltipButton>
    </li>
  )
}

function DrawerButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      title={label}
      aria-label={label}
      onClick={onClick}
      className="text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-6 w-6 items-center justify-center rounded-md"
    >
      {children}
    </TooltipButton>
  )
}
