import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as models from './models'
import type { HostTarget } from './remote-host'
import type { ExtensionUIRequest, PiEvent } from './rpc'

const publicExports = [
  'AGENT_DIRECTIVE_KEYS',
  'AboutInfo',
  'AddWorktreeBranch',
  'AdvisorFinding',
  'AgentDirectivePrefs',
  'AgentSettingsHealth',
  'AppPrefs',
  'BranchInfo',
  'CLAUDE_PROVIDER_PACKAGE',
  'CheckoutResult',
  'ClaudeAccount',
  'ClaudeAccountPrefs',
  'ClaudeAccountSessions',
  'ClaudeAccountView',
  'ClaudeAccountsResult',
  'ClaudeAuthStatus',
  'ClaudeLoginState',
  'ClaudeRoutingMode',
  'ClaudeSessionAccount',
  'ClaudeStatus',
  'ClaudeUsageError',
  'ClaudeUsageSnapshot',
  'ClaudeUsageSnapshotResult',
  'ClaudeUsageWindow',
  'CodexUsageResult',
  'ComposerDraftRecord',
  'ConfigFileHealth',
  'ConnectorAuthPush',
  'ConnectorAuthState',
  'CreateSessionOptions',
  'DEFAULT_AGENT_DIRECTIVES',
  'DEFAULT_APP_PREFS',
  'DEFAULT_CLAUDE_ACCOUNT_PREFS',
  'DEFAULT_FONT_PREFS',
  'DEFAULT_HEADROOM_PREFS',
  'DEFAULT_LANE_PREFS',
  'DEFAULT_MAINTENANCE_PREFS',
  'DEFAULT_MODEL_PICKS',
  'DEFAULT_WORKTREE_PREFS',
  'DirEntry',
  'DraftAttachment',
  'FetchResult',
  'FileContent',
  'FontPrefs',
  'GhBranchCoverage',
  'GhChecks',
  'GhPrCheck',
  'GhPrCheckState',
  'GhPrFailure',
  'GhPrKey',
  'GhPrRead',
  'GhPrReadOptions',
  'GhPrRef',
  'GhPrReviewer',
  'GhPrSummary',
  'GhPrSummaryOptions',
  'GhPullRequest',
  'GhRepoPullRequests',
  'GitInfo',
  'HeadroomPrefs',
  'HeadroomStatus',
  'LANE_PREF_LIMITS',
  'LanePrSignals',
  'LanePrefs',
  'LaneSavings',
  'LiveSessionInfo',
  'LoginFlowState',
  'LoginProviderId',
  'MAX_DRAFTS',
  'MAX_DRAFT_BLOB_BYTES',
  'MAX_RECENT_MODELS',
  'MIN_CLAUDE_CONTEXT_VERSION',
  'MIN_PI_VERSION',
  'MaintenancePrefs',
  'MaintenanceReport',
  'ModelPicks',
  'OpenInDefaultAppResult',
  'OptimizationStats',
  'PackageJobAction',
  'PiHealth',
  'PiPackageEntry',
  'PiPackageResources',
  'PiResources',
  'PlanUsageWindow',
  'PullResult',
  'ReclaimCandidate',
  'ReclaimHold',
  'ReclaimHoldReason',
  'SandboxInfo',
  'SaveDialogOptions',
  'SessionMeta',
  'SessionPush',
  'SessionScanStatus',
  'StartPoint',
  'SubscriptionProvider',
  'SubscriptionProviderStatus',
  'ThemePreference',
  'UI_SCALE_MAX',
  'UI_SCALE_MIN',
  'UpdateFromMainResult',
  'UpdatePhase',
  'UpdateState',
  'WorkspaceInfo',
  'WorkspaceSessionStats',
  'WorktreeInfo',
  'WorktreePrefs',
  'WorktreeRecovery',
  'WorktreeRecreateSource',
  'clampUiScale',
  'claudeContextProviderShortfall',
  'claudeProviderState',
  'isPiTooOld',
  'normalizeAgentDirectives',
  'normalizeLanePrefs',
  'piInstallLocation',
]

describe('models public declarations', () => {
  it('keeps the complete named export inventory, including erased declarations', () => {
    const path = resolve(import.meta.dirname, 'models.ts')
    const program = ts.createProgram([path], { noEmit: true })
    const checker = program.getTypeChecker()
    const source = program.getSourceFile(path)!
    const symbol = checker.getSymbolAtLocation(source)!
    expect(
      checker
        .getExportsOfModule(symbol)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(publicExports)
  })

  it('keeps representative exact public transport and file shapes', () => {
    expectTypeOf<models.LiveSessionInfo>().toEqualTypeOf<{
      sessionId: string
      workspacePath: string
      pid?: number
      diskPath?: string
      target?: HostTarget
      laneId?: string
    }>()
    expectTypeOf<models.SessionPush>().toEqualTypeOf<
      | { kind: 'resync' }
      | { kind: 'event'; event: PiEvent }
      | { kind: 'extension-ui'; request: ExtensionUIRequest }
      | { kind: 'stderr'; text: string }
      | { kind: 'exit'; code: number | null; signal: string | null; expected: boolean }
    >()
    expectTypeOf<models.FileContent>().toEqualTypeOf<{
      revision?: string | null
      path: string
      content: string
      size: number
      mtimeMs: number
      tooLarge?: boolean
      binary?: boolean
    }>()
  })

  it('prefers the pi entry script without treating an empty string as absent', () => {
    expect(
      models.piInstallLocation({
        minVersion: '1',
        ok: true,
        binaryPath: 'node',
        prefixArgs: ['pi.js'],
      }),
    ).toBe('pi.js')
    expect(
      models.piInstallLocation({ minVersion: '1', ok: true, binaryPath: 'pi', prefixArgs: [] }),
    ).toBe('pi')
    expect(
      models.piInstallLocation({ minVersion: '1', ok: true, binaryPath: 'pi', prefixArgs: [''] }),
    ).toBe('')
    expect(models.piInstallLocation({ minVersion: '1', ok: false })).toBeUndefined()
  })

  it('keeps minimum supported versions', () => {
    expect(models.MIN_PI_VERSION).toBe('1.2.0')
    expect(models.MIN_CLAUDE_CONTEXT_VERSION).toBe('0.10.0')
  })

  it('holds pi to its minimum, passing a prerelease of it', () => {
    expect(models.isPiTooOld('1.1.9')).toBe(true)
    expect(models.isPiTooOld('1.2.0')).toBe(false)
    expect(models.isPiTooOld('1.2.0-rc.1')).toBe(false)
  })
})
