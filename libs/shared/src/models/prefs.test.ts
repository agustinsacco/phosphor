import { expect, expectTypeOf, it } from 'vitest'
import { DEFAULT_APP_PREFS, DEFAULT_MODEL_PICKS, MAX_RECENT_MODELS, type ModelPicks } from './prefs'
import { DEFAULT_APP_PREFS as facadeDefault } from '../models'
import { DEFAULT_FONT_PREFS } from './appearance'
import { DEFAULT_LANE_PREFS, DEFAULT_WORKTREE_PREFS } from './lanes'
import { DEFAULT_MAINTENANCE_PREFS } from './maintenance'
import { DEFAULT_AGENT_DIRECTIVES } from './directives'
import { DEFAULT_HEADROOM_PREFS } from './optimization'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from './providers'
import { DEFAULT_FEEDBACK_PREFS } from '../feedback'
import { DEFAULT_CONTEXT_FILE_PREFS } from '../context-files'
import { DEFAULT_VOICE_PREFS } from '../voice'
import { DEFAULT_WRITING_PREFS } from '../writing'

it('prefs composes the exact leaf identities without copying or freezing', () => {
  expect(DEFAULT_APP_PREFS).toBe(facadeDefault)
  const defaults = {
    modelPicks: DEFAULT_MODEL_PICKS,
    lanes: DEFAULT_LANE_PREFS,
    fonts: DEFAULT_FONT_PREFS,
    agentDirectives: DEFAULT_AGENT_DIRECTIVES,
    worktrees: DEFAULT_WORKTREE_PREFS,
    maintenance: DEFAULT_MAINTENANCE_PREFS,
    headroom: DEFAULT_HEADROOM_PREFS,
    claudeAccounts: DEFAULT_CLAUDE_ACCOUNT_PREFS,
    feedback: DEFAULT_FEEDBACK_PREFS,
    contextFiles: DEFAULT_CONTEXT_FILE_PREFS,
    voice: DEFAULT_VOICE_PREFS,
    writing: DEFAULT_WRITING_PREFS,
  }
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    expect(DEFAULT_APP_PREFS[key]).toBe(defaults[key])
    expect(Object.isFrozen(DEFAULT_APP_PREFS[key])).toBe(false)
  }
  expect(DEFAULT_APP_PREFS.contextBudget).toBe('')
  expect(DEFAULT_APP_PREFS.drafts).toEqual({})
})

it('prefs keeps mutable model picker arrays and family grouping', () => {
  expect(MAX_RECENT_MODELS).toBe(8)
  expect(DEFAULT_MODEL_PICKS).toEqual({ starred: [], recent: [], groupMode: 'family' })
  expect(Object.isFrozen(DEFAULT_MODEL_PICKS.starred)).toBe(false)
  expect(Object.isFrozen(DEFAULT_MODEL_PICKS.recent)).toBe(false)
  expectTypeOf<ModelPicks>().toEqualTypeOf<{
    starred: string[]
    recent: string[]
    groupMode: 'family' | 'provider'
  }>()
})
