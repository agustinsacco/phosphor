import clsx from 'clsx'

/**
 * Shared inline SVG glyphs.
 *
 * Every icon takes a `size` in px (width and height together, since all glyphs
 * are square on a 24x24 viewBox) and an optional `className` for color and
 * layout. Stroke-based glyphs inherit `currentColor`, so callers set color on
 * the icon or on an ancestor.
 */

interface IconProps {
  /** Width and height in px. */
  size?: number
  className?: string
}

/** Shared attributes for stroked, non-filled glyphs. */
function strokeProps(size: number): {
  width: number
  height: number
  viewBox: string
  fill: 'none'
  stroke: 'currentColor'
  strokeWidth: number
} {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
  }
}

/** Git branch: three nodes and a merge curve. */
export function BranchIcon({ size = 12, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 8.5v7M18 8.5a9 9 0 0 1-9 9" />
    </svg>
  )
}

/**
 * Close / dismiss ✕. `strokeWidth` is overridable because the small pane
 * buttons use a heavier weight than the modal headers to stay legible.
 */
export function CloseIcon({
  size = 14,
  strokeWidth = 2,
  className,
}: IconProps & { strokeWidth?: number }): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} strokeWidth={strokeWidth} className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

/**
 * Disclosure chevron; rotates 90° when `expanded`. `strokeWidth` is
 * overridable because the smallest chevrons need a heavier weight to stay
 * legible at 8px.
 */
export function ChevronIcon({
  expanded = false,
  size = 12,
  strokeWidth = 2.5,
  className,
}: IconProps & { expanded?: boolean; strokeWidth?: number }): React.JSX.Element {
  return (
    <svg
      {...strokeProps(size)}
      strokeWidth={strokeWidth}
      className={clsx(
        'shrink-0 transition-transform duration-150',
        expanded && 'rotate-90',
        className,
      )}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

/**
 * Disclosure chevron pointing down, for menu triggers that drop rather than
 * expand. Deliberately not `ChevronIcon` rotated: that one animates its
 * rotation, which would make a static trigger glyph spin on every re-render.
 */
export function ChevronDownIcon({
  size = 12,
  strokeWidth = 2.5,
  className,
}: IconProps & { strokeWidth?: number }): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} strokeWidth={strokeWidth} className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** Checkmark, for selected rows and copy confirmation. */
export function CheckIcon({ size = 13, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} strokeWidth={2.5} className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/** Counter-clockwise rewind arrow, for "rewind to here" on a message row. */
export function RewindIcon({ size = 13, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  )
}

/** Horizontal overflow menu (three dots). */
export function MoreIcon({ size = 16, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} strokeWidth={3} strokeLinecap="round" className={className}>
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </svg>
  )
}

/** Plus, for "new" and "attach" affordances. */
export function PlusIcon({
  size = 12,
  strokeWidth = 2,
  className,
}: IconProps & { strokeWidth?: number }): React.JSX.Element {
  return (
    <svg
      {...strokeProps(size)}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      className={className}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** Magnifier, for the sidebar's per-workspace lane search. */
export function SearchIcon({ size = 13, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} strokeLinecap="round" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </svg>
  )
}

/** Artifact: a framed pane on a stand — the sidebar nav, top bar and code block all use it. */
export function ArtifactsIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <rect x="3" y="3" width="18" height="14" rx="2" />
      <path d="M3 9h18M9 21h6" />
    </svg>
  )
}

/** Four-point spark — the Skills page. */
export function SkillsIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3z" />
    </svg>
  )
}

/** Document with a folded corner. */
export function FileIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

/** Panel with a left rail — the show/hide sidebar switch. */
export function SidebarToggleIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

/** Shell prompt caret and line. */
export function TerminalIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m5 8 4 4-4 4M13 16h6" />
    </svg>
  )
}

/** Circled plus/minus — the working tree's changes. */
export function ChangesIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <path d="M12 3v6m0 6v6M5 12h14" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

/**
 * The orchestrator: one node coordinating three others.
 *
 * Deliberately not a spark. `✳` was doing double duty — it is the "pi is
 * working" mark (see `PiSpark`, and the activity rows in `ActivityGroup`), so
 * the orchestrator's *identity* and every session's *busy state* were the same
 * glyph, and the header button swapped between the two renderings of it. A
 * hub-and-spoke says what this thread actually is: the one that manages the
 * others.
 */
export function OrchestratorIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} strokeLinecap="round" className={className}>
      <path d="M12 9V5M12 15v4M14.6 13.5l3.4 2M9.4 13.5l-3.4 2" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="3.6" r="1.6" />
      <circle cx="19.4" cy="16.4" r="1.6" />
      <circle cx="4.6" cy="16.4" r="1.6" />
    </svg>
  )
}

/** Settings cog. */
export function GearIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

/** Pinned marker — solid, so a pinned row reads at a glance. */
export function PinIcon({ size = 11, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M16 3a1 1 0 0 1 .97 1.24l-1.09 4.34 3.83 3.83a1 1 0 0 1-.7 1.71H13.5v6.38a1 1 0 0 1-2 0v-6.38H6a1 1 0 0 1-.71-1.71l3.83-3.83L8.03 4.24A1 1 0 0 1 9 3h7z" />
    </svg>
  )
}

/**
 * Star toggle for the model picker. Filled means starred; the outline is the
 * off state, and both occupy the same box so the row does not shift on toggle.
 */
export function StarIcon({
  size = 13,
  className,
  filled = false,
}: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m12 2.8 2.9 5.87 6.48.95-4.69 4.57 1.11 6.45L12 17.6l-5.8 3.05 1.11-6.45-4.69-4.57 6.48-.95L12 2.8z" />
    </svg>
  )
}

/** Tray with a down arrow, for "save to disk". */
export function DownloadIcon({ size = 12, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  )
}

/** Circular arrow, for "read that number again". */
export function RefreshIcon({ size = 12, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className} strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

/**
 * Indeterminate activity spinner. Colour comes from `className` so callers can
 * tint it (accent for tools, warning for retries) or inherit from an ancestor.
 */
export function Spinner({ className = 'text-accent' }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={clsx('h-3.5 w-3.5 shrink-0 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"
      />
    </svg>
  )
}

/** Warning triangle, for a decision the user has to make before proceeding. */
export function WarningIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg {...strokeProps(size)} className={className} strokeLinecap="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}
