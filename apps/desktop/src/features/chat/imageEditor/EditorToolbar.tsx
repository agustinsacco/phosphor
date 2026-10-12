import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import { iconButtonClass } from '@/components/ComposerButtons'
import { formatShortcut } from '@/lib/shortcuts'

/**
 * The annotator's toolbar: tools, colour, size, history and the two image
 * sources. Presentational only; `ImageEditor` owns every piece of state.
 */

export type Tool = 'select' | 'pen' | 'highlight' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'step'

export type Size = 'S' | 'M' | 'L'

/** Screen-pixel sizes; the editor multiplies by its zoom when drawing. */
export const SIZES: Record<Size, { stroke: number; text: number; step: number }> = {
  S: { stroke: 3, text: 16, step: 11 },
  M: { stroke: 5, text: 22, step: 15 },
  L: { stroke: 8, text: 30, step: 20 },
}

/** Red first: it is the colour that reads as "look here" on a screenshot. */
export const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#111111', '#ffffff']

/** A stroked 24×24 glyph from one path (subpaths allowed). */
function glyph(d: string): React.JSX.Element {
  return (
    <svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const CIRCLE = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0'

/** Each tool's single-letter shortcut is its `key`. */
export const TOOLS: { tool: Tool; key: string; label: string; icon: React.JSX.Element }[] = [
  { tool: 'select', key: 'v', label: 'Select and move', icon: glyph('M5 3l6 17 2.5-7.5L21 10z') },
  { tool: 'rect', key: 'r', label: 'Rectangle', icon: glyph('M4 5h16v14H4z') },
  {
    tool: 'ellipse',
    key: 'o',
    label: 'Circle',
    icon: glyph('M3 12a9 7.5 0 1 0 18 0a9 7.5 0 1 0 -18 0'),
  },
  { tool: 'arrow', key: 'a', label: 'Arrow', icon: glyph('M5 19L19 5M9 5h10v10') },
  {
    tool: 'pen',
    key: 'p',
    label: 'Draw',
    icon: glyph('M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z'),
  },
  {
    tool: 'highlight',
    key: 'h',
    label: 'Highlight',
    icon: glyph('M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 01-2.8 0l-5.2-5.2a2 2 0 010-2.8L14 4'),
  },
  { tool: 'text', key: 't', label: 'Text', icon: glyph('M5 7V4h14v3M12 4v16M9 20h6') },
  { tool: 'step', key: 'n', label: 'Numbered marker', icon: glyph(`${CIRCLE}M10.5 9l2-1.5V16`) },
]

/** Keeps focus where it is (the text being typed) when a control is clicked. */
const keepFocus = (event: React.MouseEvent): void => event.preventDefault()

const TEXT_BUTTON =
  'text-text-secondary hover:text-text hover:bg-bg-secondary rounded-md px-2 py-1 text-base'

function Divider(): React.JSX.Element {
  return <div className="bg-border mx-1 h-5 w-px" />
}

function ActionButton(props: {
  label: string
  shortcut: string
  icon: string
  enabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      aria-label={props.label}
      title={`${props.label} (${props.shortcut})`}
      disabled={!props.enabled}
      onClick={props.onClick}
      className={iconButtonClass}
    >
      {glyph(props.icon)}
    </TooltipButton>
  )
}

export function EditorToolbar(props: {
  tool: Tool
  onTool: (tool: Tool) => void
  color: string
  onColor: (color: string) => void
  size: Size
  onSize: (size: Size) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  canDelete: boolean
  onDelete: () => void
  onPaste: () => void
  onReplace: () => void
}): React.JSX.Element {
  return (
    <div
      className="border-border flex flex-wrap items-center gap-0.5 border-b px-3 py-1.5"
      role="toolbar"
      aria-label="Annotation tools"
    >
      {TOOLS.map(({ tool, key, label, icon }) => (
        <TooltipButton
          key={tool}
          type="button"
          aria-label={label}
          aria-pressed={props.tool === tool}
          title={`${label} (${key.toUpperCase()})`}
          onClick={() => props.onTool(tool)}
          className={clsx(
            iconButtonClass,
            props.tool === tool && 'bg-bg-secondary text-text ring-border-strong ring-1',
          )}
        >
          {icon}
        </TooltipButton>
      ))}
      <Divider />
      {COLORS.map((c) => (
        <TooltipButton
          key={c}
          type="button"
          aria-label={`Colour ${c}`}
          aria-pressed={props.color === c}
          onMouseDown={keepFocus}
          onClick={() => props.onColor(c)}
          className="flex h-8 w-7 items-center justify-center"
        >
          <span
            style={{ background: c }}
            className={clsx(
              'border-border-strong h-4.5 w-4.5 rounded-full border',
              props.color === c && 'ring-accent ring-2 ring-offset-1',
            )}
          />
        </TooltipButton>
      ))}
      <Divider />
      {(['S', 'M', 'L'] as const).map((s, i) => (
        <TooltipButton
          key={s}
          type="button"
          aria-label={`Size ${s}`}
          aria-pressed={props.size === s}
          title={['Thin', 'Medium', 'Thick'][i]}
          onMouseDown={keepFocus}
          onClick={() => props.onSize(s)}
          className={clsx(iconButtonClass, props.size === s && 'bg-bg-secondary text-text')}
        >
          <span
            className="rounded-full bg-current"
            style={{ width: 4 + i * 4, height: 4 + i * 4 }}
          />
        </TooltipButton>
      ))}
      <Divider />
      <ActionButton
        label="Undo"
        shortcut={formatShortcut('mod', 'Z')}
        icon="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11"
        enabled={props.canUndo}
        onClick={props.onUndo}
      />
      <ActionButton
        label="Redo"
        shortcut={formatShortcut('mod', 'shift', 'Z')}
        icon="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13"
        enabled={props.canRedo}
        onClick={props.onRedo}
      />
      <ActionButton
        label="Delete selected"
        shortcut="Delete"
        icon="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"
        enabled={props.canDelete}
        onClick={props.onDelete}
      />
      <div className="ml-auto flex items-center gap-1">
        <TooltipButton
          type="button"
          title={`Put the clipboard's image on top (${formatShortcut('mod', 'V')})`}
          onClick={props.onPaste}
          className={TEXT_BUTTON}
        >
          Paste image
        </TooltipButton>
        <TooltipButton
          type="button"
          title={`Swap the screenshot underneath for the clipboard's image (${formatShortcut('mod', 'shift', 'V')})`}
          onClick={props.onReplace}
          className={TEXT_BUTTON}
        >
          Replace image
        </TooltipButton>
      </div>
    </div>
  )
}
