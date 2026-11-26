import { useTreeActions } from '@/features/chat/treeViewActions'
import { useSessionTree } from '@/features/chat/useSessionTree'
import type { HostEditLane } from '@/features/chat/hostLaneEditing'
import { TooltipButton } from '@/components/Tooltip'
import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { SessionMeta } from '@shared/models'
import { buildTreeLayout, type DisplayNode } from './treeLayout'
import { useEscapeKey } from '@/components/Modal'
import { panBy, zoomAtPoint } from './panZoom'
import { sessionTitle } from '@/lib/sessionTitle'

const COL_WIDTH = 220
const ROW_HEIGHT = 92
const NODE_WIDTH = 190
const NODE_HEIGHT = 64

interface TreeDrag {
  startX: number
  startY: number
  originX: number
  originY: number
}

/** Interactive session tree: pan/zoom, jump, fork-at-node, label, preview. */
export function TreeViewModal({
  meta,
  hostLane,
  workspacePath,
  onClose,
}: {
  hostLane?: HostEditLane
  meta: Pick<SessionMeta, 'path' | 'firstUserText' | 'name'>
  workspacePath: string
  onClose: () => void
}): React.JSX.Element {
  const { tree, error, reload } = useSessionTree(meta.path, hostLane)
  const [selected, setSelected] = useState<DisplayNode | null>(null)
  const [transform, setTransform] = useState({ x: 60, y: 40, scale: 1 })
  const dragRef = useRef<TreeDrag | null>(null)

  useEscapeKey(onClose)

  const layout = useMemo(() => (tree ? buildTreeLayout(tree) : null), [tree])

  const position = (node: DisplayNode): { px: number; py: number } => ({
    px: node.x * COL_WIDTH,
    py: node.depth * ROW_HEIGHT,
  })

  const handleWheel = (event: React.WheelEvent): void => {
    event.stopPropagation()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const cx = event.clientX - rect.left
    const cy = event.clientY - rect.top
    setTransform((t) => zoomAtPoint(t, event.deltaY, cx, cy))
  }

  const startDrag = (event: React.MouseEvent): void => {
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    }
  }
  const onDrag = (event: React.MouseEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    setTransform((t) =>
      panBy(
        t,
        { x: drag.originX, y: drag.originY },
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      ),
    )
  }
  const endDrag = (): void => {
    dragRef.current = null
  }

  const { busy, jumpHere, forkHere, labelNode } = useTreeActions(
    meta.path,
    workspacePath,
    hostLane,
    onClose,
    () => {
      reload()
      setSelected(null)
    },
  )

  return createPortal(
    <div className="bg-bg/95 fixed inset-0 z-40 flex flex-col backdrop-blur-sm">
      <header className="border-border flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <TreeIcon />
        <div className="min-w-0 flex-1">
          <span className="text-lg font-semibold">
            {sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ??
              'Session tree'}
          </span>
          <span className="text-text-tertiary ml-2 text-sm">
            {error ? (
              <>
                {error}{' '}
                <TooltipButton tooltip="Reload the session tree" onClick={reload}>
                  Retry
                </TooltipButton>
              </>
            ) : layout ? (
              `${layout.nodes.length - 1} nodes`
            ) : (
              'loading…'
            )}
            {busy ? ` · ${busy}` : ''}
          </span>
        </div>
        <div className="text-text-tertiary text-sm">scroll to zoom · drag to pan</div>
        <TooltipButton
          aria-label="Close session tree"
          onClick={onClose}
          className="text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        >
          ✕
        </TooltipButton>
      </header>

      <div
        className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={startDrag}
        onMouseMove={onDrag}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        {layout && (
          <svg className="h-full w-full">
            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
              {layout.edges.map((edge) => {
                const from = layout.nodes.find((n) => n.id === edge.fromId)!
                const to = layout.nodes.find((n) => n.id === edge.toId)!
                const a = position(from)
                const b = position(to)
                const x1 = a.px + NODE_WIDTH / 2
                const y1 = a.py + (from.kind === 'root' ? 18 : NODE_HEIGHT)
                const x2 = b.px + NODE_WIDTH / 2
                const y2 = b.py
                const midY = (y1 + y2) / 2
                return (
                  <g key={`${edge.fromId}-${edge.toId}`}>
                    <path
                      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                      fill="none"
                      stroke={edge.onActivePath ? 'var(--px-accent)' : 'var(--px-border-strong)'}
                      strokeWidth={edge.onActivePath ? 2 : 1.25}
                    />
                    {edge.collapsedCount > 0 && (
                      <g transform={`translate(${(x1 + x2) / 2}, ${midY})`}>
                        <rect
                          x={-16}
                          y={-9}
                          width={32}
                          height={18}
                          rx={9}
                          fill="var(--px-bg-secondary)"
                          stroke="var(--px-border)"
                        />
                        <text
                          textAnchor="middle"
                          dy="3.5"
                          fontSize="9.5"
                          fill="var(--px-text-tertiary)"
                        >
                          +{edge.collapsedCount}
                        </text>
                      </g>
                    )}
                  </g>
                )
              })}

              {layout.nodes.map((node) => {
                if (node.kind === 'root') {
                  const { px, py } = position(node)
                  return (
                    <g key={node.id} transform={`translate(${px + NODE_WIDTH / 2}, ${py + 10})`}>
                      <circle r={7} fill="var(--px-border-strong)" />
                      <text
                        textAnchor="middle"
                        dy="-14"
                        fontSize="10"
                        fill="var(--px-text-tertiary)"
                      >
                        session start
                      </text>
                    </g>
                  )
                }
                const { px, py } = position(node)
                return (
                  <g
                    key={node.id}
                    data-tooltip="Inspect tree node"
                    transform={`translate(${px}, ${py})`}
                    className="cursor-pointer"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelected(node)
                    }}
                  >
                    <rect
                      width={NODE_WIDTH}
                      height={NODE_HEIGHT}
                      rx={10}
                      fill={
                        node.kind === 'user'
                          ? 'var(--px-surface)'
                          : node.kind === 'summary'
                            ? 'var(--px-accent-soft)'
                            : 'var(--px-bg-secondary)'
                      }
                      stroke={
                        node.isLeaf
                          ? 'var(--px-accent)'
                          : selected?.id === node.id
                            ? 'var(--px-border-strong)'
                            : 'var(--px-border)'
                      }
                      strokeWidth={node.isLeaf ? 2.5 : 1.25}
                    />
                    <foreignObject width={NODE_WIDTH} height={NODE_HEIGHT}>
                      <div className="flex h-full flex-col justify-center gap-0.5 px-2.5 py-1.5">
                        <div className="flex items-center gap-1">
                          <span
                            className={clsx(
                              'text-2xs font-bold font-mono uppercase tracking-wider',
                              node.kind === 'user' && 'text-info',
                              node.kind === 'summary' && 'text-accent',
                              node.kind === 'compaction' && 'text-warning',
                              node.kind === 'marker' && 'text-text-tertiary',
                            )}
                          >
                            {node.kind === 'user'
                              ? 'user'
                              : node.kind === 'summary'
                                ? 'branch'
                                : node.kind === 'compaction'
                                  ? 'compaction'
                                  : 'point'}
                          </span>
                          {node.isLeaf && (
                            <span className="text-accent text-2xs font-bold font-mono uppercase tracking-wider">
                              · current
                            </span>
                          )}
                        </div>
                        <div className="text-text line-clamp-2 text-xs leading-snug">
                          {node.preview ?? node.toolSummary ?? '—'}
                        </div>
                      </div>
                    </foreignObject>
                    {node.configChanges.length > 0 && (
                      <g transform={`translate(6, ${NODE_HEIGHT + 4})`}>
                        {node.configChanges.slice(0, 2).map((change, i) => {
                          const width = Math.min(NODE_WIDTH - 12, change.label.length * 5.2 + 22)
                          return (
                            <g key={i} transform={`translate(0, ${i * 15})`}>
                              <rect
                                width={width}
                                height={13}
                                rx={6.5}
                                fill="var(--px-bg-secondary)"
                                stroke="var(--px-border)"
                              />
                              <text x={6} dy={9.2} fontSize="8" fill="var(--px-text-secondary)">
                                {change.kind === 'model' ? '◆ ' : '✳ '}
                                {change.label.length > 30
                                  ? change.label.slice(0, 29) + '…'
                                  : change.label}
                              </text>
                            </g>
                          )
                        })}
                      </g>
                    )}
                    {node.label && (
                      <g transform={`translate(${NODE_WIDTH - 8}, -8)`}>
                        <rect
                          x={-node.label.length * 5.4 - 14}
                          y={-9}
                          width={node.label.length * 5.4 + 20}
                          height={18}
                          rx={9}
                          fill="var(--px-warning)"
                          opacity={0.92}
                        />
                        <text
                          textAnchor="end"
                          x={0}
                          dy="3.5"
                          fontSize="9.5"
                          fill="#fff"
                          fontWeight={600}
                        >
                          ⚑ {node.label}
                        </text>
                      </g>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}

        {selected && (
          <div className="border-border bg-surface-raised absolute bottom-4 right-4 w-96 rounded-lg border p-4 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold font-mono uppercase tracking-wide">
                {selected.kind === 'user' ? 'User message' : selected.kind}
                {selected.isLeaf && <span className="text-accent"> · current position</span>}
              </div>
              <TooltipButton
                aria-label="Close node details"
                onClick={() => setSelected(null)}
                className="text-text-tertiary hover:text-text"
              >
                ✕
              </TooltipButton>
            </div>
            <div className="text-text-secondary mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-base">
              {selected.preview ?? '(no text preview)'}
            </div>
            {selected.label && <div className="text-warning mt-2 text-sm">⚑ {selected.label}</div>}
            <div className="mt-3 flex flex-wrap gap-1.5">
              <ActionButton
                disabled={!!busy || selected.isLeaf}
                onClick={() => void jumpHere(selected)}
              >
                Jump here
              </ActionButton>
              <ActionButton disabled={!!busy} onClick={() => void forkHere(selected)}>
                Fork into new session
              </ActionButton>
              <ActionButton disabled={!!busy} onClick={() => void labelNode(selected)}>
                {selected.label ? 'Edit label' : 'Add label'}
              </ActionButton>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function ActionButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <TooltipButton
      disabled={disabled}
      onClick={onClick}
      className="border-border hover:border-border-strong hover:bg-bg-secondary rounded-md border px-2.5 py-1 text-sm font-medium transition-colors disabled:opacity-40"
    >
      {children}
    </TooltipButton>
  )
}

function TreeIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-accent"
    >
      <circle cx="12" cy="4" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="19" r="2.2" />
      <path d="M12 6.5v4M12 10.5 6.8 17M12 10.5l5.2 6.5" />
    </svg>
  )
}
