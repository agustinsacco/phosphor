import { describe, expect, it } from 'vitest'
import * as models from './models'
import { DEFAULT_FEEDBACK_PREFS } from './feedback'
import { DEFAULT_CONTEXT_FILE_PREFS } from './context-files'
import { DEFAULT_VOICE_PREFS } from './voice'
import { DEFAULT_WRITING_PREFS } from './writing'

const expectedDefaults = {
  theme: 'dark',
  recentWorkspaces: [],
  pinnedSessions: [],
  rewoundSessions: {},
  sessionOrder: [],
  modelPicks: { starred: [], recent: [], groupMode: 'family' },
  collapsedWorkspaces: [],
  seenSessions: {},
  laneMarkers: {},
  lanes: {
    markers: 'auto',
    autoName: true,
    nameMinWords: 2,
    nameMaxWords: 5,
    nameMaxLength: 60,
    branchSlugMaxLength: 40,
    prStatus: true,
  },
  fonts: {
    uiScale: 1,
    chatFontSize: 14.5,
    editorFontSize: 12.5,
    terminalFontSize: 12.5,
    monoFont: 'JetBrains Mono',
  },
  agentDirectives: {
    machineAwareness: true,
    worktreeGuard: true,
    laneCharter: true,
    subagentPolicy: true,
  },
  agentDirectivesByProject: {},
  retiredDirectives: {},
  worktrees: {
    auto: true,
    branchPrefix: 'phosphor/',
  },
  maintenance: {
    enabled: true,
    intervalMinutes: 60,
    reclaimMergedWorktrees: false,
    minAgeHours: 24,
  },
  headroom: {
    // Off by default: turning it on is a ~500 MB install decision plus a local
    // service, and Phosphor never makes that decision silently.
    enabled: false,
  },
  voice: {
    // Off by default: turning it on is a download and a microphone.
    enabled: false,
    model: 'moonshine-tiny-en',
  },
  feedback: { launches: 0 },
  contextBudget: '',
  contextFiles: { claude: true, agents: true },
  writing: { spellcheck: true, autocomplete: false },
  claudeAccounts: {
    accounts: [],
    mode: 'specific',
    cursor: 0,
    cooldowns: {},
    bindings: {},
  },
  drafts: {},
}

const leafDefaults = {
  modelPicks: models.DEFAULT_MODEL_PICKS,
  lanes: models.DEFAULT_LANE_PREFS,
  fonts: models.DEFAULT_FONT_PREFS,
  agentDirectives: models.DEFAULT_AGENT_DIRECTIVES,
  worktrees: models.DEFAULT_WORKTREE_PREFS,
  maintenance: models.DEFAULT_MAINTENANCE_PREFS,
  headroom: models.DEFAULT_HEADROOM_PREFS,
  voice: DEFAULT_VOICE_PREFS,
  feedback: DEFAULT_FEEDBACK_PREFS,
  contextFiles: DEFAULT_CONTEXT_FILE_PREFS,
  writing: DEFAULT_WRITING_PREFS,
  claudeAccounts: models.DEFAULT_CLAUDE_ACCOUNT_PREFS,
}

describe('models public preferences', () => {
  it('keeps every default value and its absence of optional keys', () => {
    expect(models.DEFAULT_APP_PREFS).toStrictEqual(expectedDefaults)
  })

  it('aliases every exported leaf default without freezing objects or arrays', () => {
    for (const [key, value] of Object.entries(leafDefaults)) {
      expect(models.DEFAULT_APP_PREFS[key as keyof models.AppPrefs]).toBe(value)
      expect(Object.isFrozen(value)).toBe(false)
    }
    expect(Object.isFrozen(models.DEFAULT_APP_PREFS.modelPicks.starred)).toBe(false)
    expect(Object.isFrozen(models.DEFAULT_APP_PREFS.modelPicks.recent)).toBe(false)
    expect(Object.isFrozen(models.DEFAULT_APP_PREFS.claudeAccounts?.accounts)).toBe(false)
    expect(Object.isFrozen(models.DEFAULT_APP_PREFS.recentWorkspaces)).toBe(false)
  })

  it.each([
    [NaN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    [-1, 0.7],
    [0.7, 0.7],
    [1.2345, 1.2345],
    [2, 2],
    [3, 2],
  ])('clamps UI scale %s to %s without rounding', (input, expected) => {
    expect(models.clampUiScale(input)).toBe(expected)
  })

  it('returns a fresh default lane value for absent or empty input', () => {
    expect(models.normalizeLanePrefs(undefined)).toEqual(models.DEFAULT_LANE_PREFS)
    expect(models.normalizeLanePrefs({})).toEqual(models.DEFAULT_LANE_PREFS)
    expect(models.normalizeLanePrefs(undefined)).not.toBe(models.DEFAULT_LANE_PREFS)
  })

  it('rounds and bounds lane numbers, then raises maximum words to minimum', () => {
    expect(
      models.normalizeLanePrefs({
        nameMinWords: 6.5,
        nameMaxWords: 2.49,
        nameMaxLength: 15.5,
        branchSlugMaxLength: 100,
      }),
    ).toEqual({
      markers: 'auto',
      autoName: true,
      nameMinWords: 7,
      nameMaxWords: 7,
      nameMaxLength: 16,
      branchSlugMaxLength: 80,
      prStatus: true,
    })
    expect(
      models.normalizeLanePrefs({
        nameMinWords: -100,
        nameMaxWords: 100,
        nameMaxLength: 121,
        branchSlugMaxLength: 0,
      }),
    ).toEqual({
      markers: 'auto',
      autoName: true,
      nameMinWords: 1,
      nameMaxWords: 12,
      nameMaxLength: 120,
      branchSlugMaxLength: 12,
      prStatus: true,
    })
  })

  it('falls back independently on nonfinite and nonnumeric lane values', () => {
    const input = {
      nameMinWords: NaN,
      nameMaxWords: Infinity,
      nameMaxLength: '55',
      branchSlugMaxLength: null,
    }
    expect(models.normalizeLanePrefs(input as unknown as Partial<models.LanePrefs>)).toEqual(
      models.DEFAULT_LANE_PREFS,
    )
    expect(models.normalizeLanePrefs({ nameMinWords: 12, nameMaxWords: NaN }).nameMaxWords).toBe(12)
  })

  it.each([
    ['manual', 0, 'false', 'manual', false, true],
    ['off', null, '', 'off', false, false],
    ['bad', undefined, undefined, 'auto', false, false],
    [null, [], {}, 'auto', true, true],
  ])(
    'normalizes marker %s and coerces booleans %s/%s',
    (markers, autoName, prStatus, expectedMarkers, expectedAutoName, expectedPrStatus) => {
      const input = { markers, autoName, prStatus } as unknown as Partial<models.LanePrefs>
      expect(models.normalizeLanePrefs(input)).toEqual({
        ...models.DEFAULT_LANE_PREFS,
        markers: expectedMarkers,
        autoName: expectedAutoName,
        prStatus: expectedPrStatus,
      })
    },
  )

  it('never mutates the input or exported lane default', () => {
    const input = Object.freeze({ markers: 'manual' as const, nameMinWords: 8, nameMaxWords: 1 })
    const before = structuredClone(input)
    const defaultBefore = structuredClone(models.DEFAULT_LANE_PREFS)
    models.normalizeLanePrefs(input)
    expect(input).toStrictEqual(before)
    expect(models.DEFAULT_LANE_PREFS).toStrictEqual(defaultBefore)
  })
})
