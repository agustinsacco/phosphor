import { describe, expect, it } from 'vitest'
import { composeDirectives, subagentPolicyBlock } from './directives'
import type { AgentDirectivePrefs, GitInfo } from '@shared/models'

const CWD = '/home/u/src/phosphor/.phosphor/worktrees/read-composer'
const GIT: GitInfo = { isRepo: true, isWorktree: true, mainRepoPath: '/home/u/src/phosphor' }
const CHARTER = { branch: 'phosphor/read-composer', base: 'main' }

const ALL_OFF: AgentDirectivePrefs = {
  worktreeGuard: false,
  laneCharter: false,
  subagentPolicy: false,
  custom: '',
}

function compose(prefs: Partial<AgentDirectivePrefs>): string {
  return (
    composeDirectives({
      cwd: CWD,
      git: GIT,
      prefs: { ...ALL_OFF, ...prefs },
      charter: CHARTER,
    }) ?? ''
  )
}

describe('subagentPolicyBlock', () => {
  it('asks for the synchronous form rather than banning the tool', () => {
    const block = subagentPolicyBlock()
    expect(block).toContain('run_in_background: false')
    expect(block).toContain('When sub-agent tools are available')
    expect(block).toContain('Native Claude Code Agent/Task:')
    expect(block).toContain('pi subagent: follow its advertised schema')
    expect(block).toContain('Do not add run_in_background')
    expect(block).not.toContain('dies with the turn')
    expect(block).not.toContain('0.4.14')
  })
})

describe('composeDirectives', () => {
  it('emits nothing when every block is off and there is no custom text', () => {
    expect(
      composeDirectives({ cwd: CWD, git: GIT, prefs: ALL_OFF, charter: CHARTER }),
    ).toBeUndefined()
  })

  it('includes each block only when its toggle is on', () => {
    expect(compose({ worktreeGuard: true })).toContain('<phosphor_workspace>')
    expect(compose({ worktreeGuard: true })).not.toContain('<phosphor_subagents>')

    expect(compose({ subagentPolicy: true })).toContain('<phosphor_subagents>')
    expect(compose({ subagentPolicy: true })).not.toContain('<phosphor_lane>')

    expect(compose({ laneCharter: true })).toContain('<phosphor_lane>')
  })

  it('keeps the documented order: workspace, lane, sub-agents, custom', () => {
    const out = compose({
      worktreeGuard: true,
      laneCharter: true,
      subagentPolicy: true,
      custom: 'MY OWN TEXT',
    })
    const order = [
      '<phosphor_workspace>',
      '<phosphor_lane>',
      '<phosphor_subagents>',
      'MY OWN TEXT',
    ].map((needle) => out.indexOf(needle))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('drops the lane charter without a charter, but keeps the sub-agent policy', () => {
    const out =
      composeDirectives({
        cwd: CWD,
        git: GIT,
        prefs: { ...ALL_OFF, laneCharter: true, subagentPolicy: true },
      }) ?? ''
    expect(out).not.toContain('<phosphor_lane>')
    expect(out).toContain('<phosphor_subagents>')
  })
})
