import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ActionSheet, ActionSheetItem } from '@/components/ActionSheet'
import { MenuRow, PopupMenu } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import { CheckIcon, LinkIcon, RefreshIcon } from '@/components/icons'
import type { LanePr } from '../lanePrs'
import { PrGlyph } from './PrIcons'
import type { InspectorActions } from './useInspectorActions'

export const ICON_BUTTON =
  'text-text-secondary hover:bg-bg-secondary hover:text-text focus-visible:outline-accent grid size-6 place-items-center rounded-md focus-visible:outline focus-visible:outline-2 disabled:opacity-45'

/**
 * Open on GitHub, Copy link, Refresh and a menu holding "Hide from this lane".
 * A suggestion also gets "Track", the keyboard route to the list's `+`.
 *
 * In a phone's sheet the row sits above the header instead of in its corner,
 * and its menu is a sheet that also holds Track in this lane and Track a PR….
 */
export function PrHeaderActions({
  item,
  suggestion,
  refreshing,
  act,
  onRefresh,
  sheet = false,
}: {
  item: LanePr
  suggestion: boolean
  refreshing: boolean
  act: InspectorActions
  onRefresh: () => void
  sheet?: boolean
}): React.JSX.Element {
  const url = item.pr?.url
  const ref = item.ref
  return (
    <div
      className={clsx(
        'flex items-center gap-0.5',
        sheet ? 'order-first justify-end px-2 pt-1' : 'absolute right-2 top-2',
      )}
      data-testid="pr-inspector-actions"
    >
      {!sheet && suggestion && ref && (
        <TooltipButton
          type="button"
          onClick={() => act.override('pin', ref)}
          tooltip="Track in this lane"
          className="border-border-strong hover:border-text-tertiary focus-visible:outline-accent mr-1 flex h-6 items-center gap-1 rounded-md border px-2 text-base focus-visible:outline focus-visible:outline-2"
        >
          <PrGlyph glyph="plus" size={12} />
          Track
        </TooltipButton>
      )}
      <TooltipButton
        type="button"
        aria-label="Open on GitHub"
        disabled={!url}
        onClick={() => url && act.open(url)}
        className={ICON_BUTTON}
      >
        <PrGlyph glyph="external" size={14} />
      </TooltipButton>
      <CopyLink disabled={!url} onCopy={() => act.copy(url ?? '')} />
      <TooltipButton
        type="button"
        aria-label={refreshing ? 'Refreshing' : 'Refresh'}
        aria-busy={refreshing}
        onClick={onRefresh}
        className={ICON_BUTTON}
      >
        <RefreshIcon
          size={13}
          className={clsx(refreshing && 'animate-spin motion-reduce:animate-none')}
        />
      </TooltipButton>
      {sheet ? (
        <MoreSheet
          title={item.pr?.title}
          onTrack={suggestion && ref ? () => act.override('pin', ref) : undefined}
          onTrackOther={act.trackOther}
          onHide={ref ? () => act.override('hide', ref) : undefined}
        />
      ) : (
        ref && <MoreMenu onHide={() => act.override('hide', ref)} />
      )}
    </div>
  )
}

/** A phone's overflow menu: Track and Hide, as a sheet over the inspector's. */
function MoreSheet({
  title,
  onTrack,
  onTrackOther,
  onHide,
}: {
  title: string | undefined
  onTrack?: () => void
  onTrackOther: () => void
  onHide?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const run = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  return (
    <>
      <TooltipButton
        ref={moreRef}
        type="button"
        aria-label="More actions"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={ICON_BUTTON}
      >
        <PrGlyph glyph="more" size={14} />
      </TooltipButton>
      {open && (
        <ActionSheet
          label="Pull request actions"
          head={title && <strong className="truncate">{title}</strong>}
          returnFocus={moreRef.current}
          onClose={() => setOpen(false)}
        >
          {onTrack && <ActionSheetItem onClick={run(onTrack)}>Track in this lane</ActionSheetItem>}
          <ActionSheetItem onClick={run(onTrackOther)}>Track a PR…</ActionSheetItem>
          {onHide && <ActionSheetItem onClick={run(onHide)}>Hide from this lane</ActionSheetItem>}
        </ActionSheet>
      )}
    </>
  )
}

/** Focus the menu's first row as it opens. */
function MenuOnOpen({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus({ preventScroll: true })
  }, [])
  return <div ref={ref}>{children}</div>
}

function CopyLink({
  disabled,
  onCopy,
}: {
  disabled: boolean
  onCopy: () => Promise<boolean>
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <TooltipButton
      type="button"
      aria-label={copied ? 'Link copied' : 'Copy link'}
      disabled={disabled}
      onClick={() => {
        void onCopy().then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1_400)
        })
      }}
      className={ICON_BUTTON}
    >
      {copied ? <CheckIcon size={13} /> : <LinkIcon size={13} />}
    </TooltipButton>
  )
}

/** The overflow menu: "Hide from this lane". */
function MoreMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="relative">
      <TooltipButton
        ref={moreRef}
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((open) => !open)}
        className={ICON_BUTTON}
      >
        <PrGlyph glyph="more" size={14} />
      </TooltipButton>
      {menu && (
        <PopupMenu
          triggerRef={moreRef}
          onClose={() => {
            setMenu(false)
            moreRef.current?.focus()
          }}
          className="absolute right-0 top-full z-40 mt-1 w-48 py-1"
        >
          <MenuOnOpen>
            <MenuRow
              active={false}
              onClick={() => {
                setMenu(false)
                onHide()
              }}
            >
              Hide from this lane
            </MenuRow>
          </MenuOnOpen>
        </PopupMenu>
      )}
    </div>
  )
}
