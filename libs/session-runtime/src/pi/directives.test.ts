import { describe, expect, it } from 'vitest'
import { composeDirectives, subagentPolicyBlock } from './directives'
import type { AgentDirectivePrefs, GitInfo } from '@shared/models'

const CWD = '/home/u/src/phosphor/.phosphor/worktrees/read-composer'
const GIT: GitInfo = { isRepo: true, isWorktree: true, mainRepoPath: '/home/u/src/phosphor' }
const CHARTER = { branch: 'phosphor/read-composer', base: 'main' }

const ALL_OFF: AgentDirectivePrefs = {
  machineAwareness: true,
  worktreeGuard: false,
  laneCharter: false,
  subagentPolicy: false,
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
  it('emits nothing when every block is off', () => {
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

  it('keeps the documented order: workspace, machine, lane, sub-agents', () => {
    const out =
      composeDirectives({
        cwd: CWD,
        git: GIT,
        prefs: {
          machineAwareness: true,
          worktreeGuard: true,
          laneCharter: true,
          subagentPolicy: true,
        },
        charter: CHARTER,
        machine: { kind: 'desktop', signedIn: true },
      }) ?? ''
    const order = [
      '<phosphor_workspace>',
      '<phosphor_machine>',
      '<phosphor_lane>',
      '<phosphor_subagents>',
    ].map((needle) => out.indexOf(needle))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('ignores free text a stored pref still carries: the user’s text lives in AGENTS.md', () => {
    const stored = { ...ALL_OFF, custom: 'MY OWN TEXT' } as AgentDirectivePrefs
    expect(
      composeDirectives({ cwd: CWD, git: GIT, prefs: stored, charter: CHARTER }),
    ).toBeUndefined()
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
