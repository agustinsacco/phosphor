import { useState } from 'react'
import clsx from 'clsx'
import { ChevronIcon } from '@/components/icons'
import { isFleetActive, type FleetNode } from './subagentRuns'
import type { SubagentTarget } from './subagentView'
import { SubagentActivity } from './SubagentActivity'

/** Fixed three-line rows. Live counters/tool names never add lines to the tree. */
export function SubagentTree({
  nodes,
  target,
  onSelect,
  rootId,
}: {
  nodes: FleetNode[]
  target?: SubagentTarget
  onSelect: (target: SubagentTarget) => void
  rootId?: string
}): React.JSX.Element {
  return (
    <ul className="min-w-0 space-y-1">
      {nodes.map((node) => (
        <AgentRow key={node.id} node={node} rootId={rootId} target={target} onSelect={onSelect} />
      ))}
    </ul>
  )
}

function AgentRow({
  node,
  rootId,
  target,
  onSelect,
}: {
  node: FleetNode
  rootId?: string
  target?: SubagentTarget
  onSelect: (target: SubagentTarget) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const selected =
    target?.runId === (rootId ?? node.id) && target.childId === (rootId ? node.id : undefined)
  const label = node.kind === 'workflow' ? 'Workflow' : node.label
  const activity =
    node.currentTool ??
    (node.children.length
      ? `${node.children.length} steps shown`
      : isFleetActive(node.state)
        ? 'No tool reported'
        : 'No current activity')
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-start">
        {node.children.length > 0 && (
          <button
            className="text-text-secondary mt-2 shrink-0 rounded p-1"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.label}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ChevronIcon expanded={open} />
          </button>
        )}
        <button
          data-testid="subagent-nav-row"
          aria-label={`${node.label} ${node.state}${node.currentTool ? ` ${node.currentTool}` : ''}`}
          aria-pressed={selected}
          onClick={() =>
            onSelect({ runId: rootId ?? node.id, ...(rootId ? { childId: node.id } : {}) })
          }
          className={clsx(
            'min-w-0 flex-1 rounded-md px-2 py-2 text-left text-base',
            selected ? 'bg-accent-soft text-text' : 'text-text hover:bg-bg-secondary',
          )}
        >
          <span className="flex min-w-0 items-center gap-2 leading-5">
            <span className="min-w-0 flex-1 truncate font-medium" title={node.label}>
              {label}
            </span>
            <span
              className={clsx(
                'shrink-0 text-xs',
                isFleetActive(node.state)
                  ? 'text-accent'
                  : node.state === 'failed'
                    ? 'text-danger'
                    : 'text-text-secondary',
              )}
            >
              {node.state}
            </span>
            <span
              className="text-warning w-3 shrink-0 text-center"
              title={node.attention ? 'Needs parent attention' : undefined}
              aria-label={node.attention ? 'Needs parent attention' : undefined}
            >
              {node.attention ? '!' : ''}
            </span>
          </span>
          <span
            className="text-text-secondary block truncate font-mono text-sm leading-5"
            title={activity}
          >
            {activity}
          </span>
          <SubagentActivity node={node} />
        </button>
      </div>
      {open && node.children.length > 0 && (
        <div className="border-border ml-2 border-l pl-1">
          <SubagentTree
            nodes={node.children}
            target={target}
            onSelect={onSelect}
            rootId={rootId ?? node.id}
          />
        </div>
      )}
    </li>
  )
}
