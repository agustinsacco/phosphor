import { describe, expect, it } from 'vitest'
import { buildTreeLayout } from './treeLayout'
import type { SessionTree, SessionTreeEntry } from '@shared/ipc'

function entry(partial: Partial<SessionTreeEntry> & { id: string }): SessionTreeEntry {
  return {
    parentId: null,
    type: 'message',
    timestamp: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

describe('buildTreeLayout', () => {
  it('collapses assistant/tool chains between user messages', () => {
    const tree: SessionTree = {
      sessionId: 's',
      cwd: '/x',
      leafId: 'u2',
      entries: [
        entry({ id: 'u1', role: 'user', preview: 'first' }),
        entry({ id: 'a1', parentId: 'u1', role: 'assistant' }),
        entry({ id: 't1', parentId: 'a1', role: 'toolResult' }),
        entry({ id: 't2', parentId: 't1', role: 'toolResult' }),
        entry({ id: 'u2', parentId: 't2', role: 'user', preview: 'second' }),
      ],
    }
    const layout = buildTreeLayout(tree)
    const userNodes = layout.nodes.filter((n) => n.kind === 'user')
    expect(userNodes.map((n) => n.id)).toEqual(['u1', 'u2'])
    const edge = layout.edges.find((e) => e.toId === 'u2')!
    expect(edge.fromId).toBe('u1')
    expect(edge.collapsedCount).toBe(3)
  })

  it('marks the active path and leaf across branches', () => {
    const tree: SessionTree = {
      sessionId: 's',
      cwd: '/x',
      leafId: 'u3',
      entries: [
        entry({ id: 'u1', role: 'user', preview: 'root prompt' }),
        entry({ id: 'a1', parentId: 'u1', role: 'assistant' }),
        // branch A (abandoned)
        entry({ id: 'u2', parentId: 'a1', role: 'user', preview: 'branch A' }),
        // branch B (active)
        entry({ id: 'u3', parentId: 'a1', role: 'user', preview: 'branch B' }),
      ],
    }
    const layout = buildTreeLayout(tree)
    const u2 = layout.nodes.find((n) => n.id === 'u2')!
    const u3 = layout.nodes.find((n) => n.id === 'u3')!
    expect(u2.onActivePath).toBe(false)
    expect(u3.onActivePath).toBe(true)
    expect(u3.isLeaf).toBe(true)
    // Branch point spreads children into different columns.
    expect(u2.x).not.toBe(u3.x)
  })

  it('attaches labels to their target nodes and skips label entries as nodes', () => {
    const tree: SessionTree = {
      sessionId: 's',
      cwd: '/x',
      leafId: 'l1',
      entries: [
        entry({ id: 'u1', role: 'user', preview: 'hello' }),
        entry({ id: 'l1', parentId: 'u1', type: 'label', targetId: 'u1', label: 'checkpoint' }),
      ],
    }
    const layout = buildTreeLayout(tree)
    const u1 = layout.nodes.find((n) => n.id === 'u1')!
    expect(u1.label).toBe('checkpoint')
    expect(layout.nodes.some((n) => n.id === 'l1')).toBe(false)
    // Leaf resolution skips metadata entries: u1 is the effective leaf.
    expect(u1.isLeaf).toBe(true)
  })

  it('surfaces model and thinking-level switches as chips on the next node', () => {
    const tree: SessionTree = {
      sessionId: 's',
      cwd: '/x',
      leafId: 'u2',
      entries: [
        entry({ id: 'u1', role: 'user', preview: 'first' }),
        entry({ id: 'a1', parentId: 'u1', role: 'assistant' }),
        entry({
          id: 'm1',
          parentId: 'a1',
          type: 'model_change',
          provider: 'anthropic',
          modelId: 'claude-sonnet-4-5',
        }),
        entry({ id: 't1', parentId: 'm1', type: 'thinking_level_change', thinkingLevel: 'high' }),
        entry({ id: 'u2', parentId: 't1', role: 'user', preview: 'second' }),
      ],
    }
    const layout = buildTreeLayout(tree)
    // The config entries stay collapsed (not standalone nodes)…
    expect(layout.nodes.some((n) => n.id === 'm1' || n.id === 't1')).toBe(false)
    // …but their labels ride along on the following user message.
    const u2 = layout.nodes.find((n) => n.id === 'u2')!
    expect(u2.configChanges).toEqual([
      { kind: 'model', label: 'anthropic/claude-sonnet-4-5' },
      { kind: 'thinking', label: 'thinking: high' },
    ])
  })

  it('does not leak config chips across sibling branches', () => {
    const tree: SessionTree = {
      sessionId: 's',
      cwd: '/x',
      leafId: 'u3',
      entries: [
        entry({ id: 'u1', role: 'user', preview: 'root' }),
        // Branch point: two children, only one preceded by a model change.
        entry({ id: 'm1', parentId: 'u1', type: 'model_change', modelId: 'gpt-4o' }),
        entry({ id: 'u2', parentId: 'm1', role: 'user', preview: 'branch A' }),
        entry({ id: 'u3', parentId: 'u1', role: 'user', preview: 'branch B' }),
      ],
    }
    const layout = buildTreeLayout(tree)
    expect(layout.nodes.find((n) => n.id === 'u2')!.configChanges).toEqual([
      { kind: 'model', label: 'gpt-4o' },
    ])
    expect(layout.nodes.find((n) => n.id === 'u3')!.configChanges).toEqual([])
  })

  it('shows branch summaries as summary nodes', () => {
    const tree: SessionTree = {
      sessionId: 's',
      cwd: '/x',
      leafId: 'u2',
      entries: [
        entry({ id: 'u1', role: 'user', preview: 'first' }),
        entry({ id: 'b1', parentId: 'u1', type: 'branch_summary', summary: 'left branch did X' }),
        entry({ id: 'u2', parentId: 'b1', role: 'user', preview: 'continue' }),
      ],
    }
    const layout = buildTreeLayout(tree)
    expect(layout.nodes.find((n) => n.id === 'b1')?.kind).toBe('summary')
  })
})
