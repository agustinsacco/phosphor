import {
  mockRemoteAction,
  onMockRemoteChanged,
  mockRemoteHosts,
  mixedRemoteHosts,
  mockRemoteInfo,
} from './mockRemoteLanes'
import type { MachineView } from '@shared/control-api'
import { mockMachineSettingsInvoke } from './mockMachineSettings'
import { mockSessionMaintenance } from './mockSessionMaintenance'
/**
 * Dev-only mock of the preload API so the renderer can run in a plain
 * browser (vite dev server without Electron). Replays the captured real
 * pi event stream with realistic pacing. Never bundled in production:
 * loaded lazily behind `import.meta.env.DEV && !window.phosphor`.
 */
import type { AccountView } from '@shared/account'
import type { PhosphorApi } from '@shared/ipc'
import { mockRoutineCall, onMockRoutinesChanged } from './mockRoutines'
import { mockTraffic } from './mockTraffic'
import { bytesToBase64 } from '../lib/base64'
import type {
  ConnectorAuthPush,
  ConnectorAuthState,
  SessionPush,
  SessionMeta,
} from '@shared/models'
import { mockMcpInspection, mockMcpList } from './mockMcpInspection'
import type { ArtifactListing, ArtifactSnapshot } from '@shared/artifacts'
import { normalizeContextFilePrefs, type ContextFilePrefs } from '@shared/context-files'
import { DEFAULT_APP_PREFS, MIN_PI_VERSION } from '@shared/models'
import {
  compileSearch,
  EMPTY_SEARCH_RESULT,
  findLineMatches,
  MAX_SEARCH_RESULTS,
  type FileSearchResult,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResult,
} from '@shared/workspace-search'
import type { PiEvent, RpcCommand, RpcResponse } from '@shared/rpc'
import { DEFAULT_VOICE_PREFS, VOICE_MODELS, type VoiceStatus } from '@shared/voice'
import fixtureRaw from '../features/chat/__fixtures__/real-session-events.jsonl?raw'

const fixtureEvents: PiEvent[] = fixtureRaw
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { type: string })
  .filter((record) => record.type !== 'response') as PiEvent[]

/** The harness's one stored artifact, from a session that was deleted. */
const MOCK_STORED_ARTIFACT: { listing: ArtifactListing; artifact: ArtifactSnapshot } = {
  listing: {
    key: '01a10e05-0000-7000-8000-000000000001/release-checklist',
    sessionId: '01a10e05-0000-7000-8000-000000000001',
    id: 'release-checklist',
    sessionFile: '/Users/you/.pi/agent/sessions/--mock--/deleted.jsonl',
    cwd: '/Users/you/projects/phosphor',
    sessionName: 'Plan the 0.2 release',
    title: 'Release checklist',
    type: 'markdown',
    version: 2,
    versionCount: 2,
    updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    revision: 'call-release-checklist-2',
    sessionDeleted: true,
    workspaceExists: true,
  },
  artifact: {
    id: 'release-checklist',
    title: 'Release checklist',
    type: 'markdown',
    versions: [
      { version: 1, title: 'Release checklist', content: '# Release\n\n- [ ] Tag', createdAt: 0 },
      {
        version: 2,
        title: 'Release checklist',
        content: '# Release\n\n- [x] Tag\n- [ ] Notes',
        createdAt: 0,
      },
    ],
  },
}

let mockStoredArtifactRemoved = false

const listeners = new Map<string, Set<(push: SessionPush) => void>>()
const ptyListeners = new Map<string, Set<(data: string) => void>>()
let replaying = false

function push(sessionId: string, payload: SessionPush): void {
  for (const listener of listeners.get(sessionId) ?? []) listener(payload)
}

function replayFixture(sessionId: string): void {
  if (replaying) return
  replaying = true
  let index = 0
  // Interval-based pumping: survives aggressive background-timer throttling
  // better than chained awaits, and can't strand the `replaying` guard.
  const timer = setInterval(() => {
    try {
      const batch = 4
      for (let i = 0; i < batch && index < fixtureEvents.length; i++, index++) {
        push(sessionId, { kind: 'event', event: fixtureEvents[index]! })
      }
      if (index >= fixtureEvents.length) {
        clearInterval(timer)
        replaying = false
      }
    } catch (error) {
      console.error('[Phosphor mock] replay failed:', error)
      clearInterval(timer)
      replaying = false
    }
  }, 40)
}

/**
 * The Accounts tab's providers, one per badge state so all three are
 * reachable in the browser harness without a pi install. `mockAuthState`
 * overlays a signed-in result once a mock sign-in completes, so the flow ends
 * where the real one does: the row flipped.
 */
const MOCK_PROVIDERS = [
  {
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    requires: 'ChatGPT Plus or Pro',
    billing: 'subscription' as const,
    defaultState: { status: 'ready' as const, account: 'you@example.com' },
  },
  {
    id: 'anthropic',
    name: 'Claude Pro/Max',
    requires: 'Claude Pro or Max',
    billing: 'subscription' as const,
    caveat: 'Bills per token from extra usage, not against plan limits.',
    defaultState: { status: 'not_ready' as const, reason: 'credentials_not_configured' },
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    requires: 'a Copilot subscription',
    billing: 'subscription' as const,
    defaultState: { status: 'unknown' as const, error: 'pi is not available' },
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    requires: 'a Kimi For Coding plan',
    billing: 'subscription' as const,
    defaultState: { status: 'not_ready' as const, reason: 'credentials_not_configured' },
  },
  {
    id: 'xai',
    name: 'xAI',
    requires: 'an xAI account',
    billing: 'balance' as const,
    caveat: 'Billed per token against your xAI credit balance, not a flat plan.',
    defaultState: { status: 'not_ready' as const, reason: 'credentials_not_configured' },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    requires: 'an OpenRouter account',
    billing: 'balance' as const,
    defaultState: { status: 'not_ready' as const, reason: 'credentials_not_configured' },
  },
  {
    id: 'radius',
    name: 'Radius',
    requires: 'a Radius account',
    billing: 'balance' as const,
    defaultState: { status: 'not_ready' as const, reason: 'credentials_not_configured' },
  },
]

const mockAuthState: Record<string, { status: 'ready' | 'not_ready' | 'unknown' }> = {}
const mockLoginListeners = new Set<(state: never) => void>()
let mockLoginTimers: ReturnType<typeof setTimeout>[] = []

function emitLoginState(state: never): void {
  mockLoginListeners.forEach((listener) => listener(state))
}

/**
 * Claude CLI sign-in, mocked so the provider tab's whole flow — paste-code box,
 * rejected code, the row flipping to a new account — is developable without a
 * `claude` install.
 */
let mockClaudeAuth: { loggedIn: boolean; email?: string } = {
  loggedIn: true,
  email: 'dev@example.com',
}
/**
 * Two accounts, so the harness renders the part that only exists with more
 * than one: ordering arrows, the routing radios, and an account the ordered
 * rule would skip. `credentialDir: null` on the first is the real shape — the
 * default account is the CLI's own keychain entry.
 */
const mockClaudeAccounts: {
  prefs: {
    accounts: {
      id: string
      label: string
      email: string
      plan: string
      credentialDir: string | null
      addedAt: number
    }[]
    mode: 'specific' | 'ordered' | 'round-robin'
    pinnedId?: string
    cursor: number
    cooldowns: Record<string, number>
    bindings: Record<string, string>
  }
} = {
  prefs: {
    accounts: [
      {
        id: 'default',
        label: 'dev@example.com',
        email: 'dev@example.com',
        plan: 'max',
        credentialDir: null,
        addedAt: Date.now() - 86_400_000,
      },
      {
        id: 'work',
        label: 'dev@work.example',
        email: 'dev@work.example',
        plan: 'team',
        credentialDir: '/Users/dev/Library/Application Support/phosphor/claude-accounts/work',
        addedAt: Date.now() - 3_600_000,
      },
    ],
    mode: 'ordered',
    pinnedId: 'default',
    cursor: 0,
    cooldowns: {},
    bindings: {},
  },
}

/** Accounts plus the per-account facts the tab renders. */
function mockAccountViews(): unknown {
  return {
    prefs: mockClaudeAccounts.prefs,
    views: mockClaudeAccounts.prefs.accounts.map((account, index) => ({
      account,
      auth: {
        ok: true,
        loggedIn: true,
        method: 'claude.ai',
        email: account.email,
        plan: account.plan,
      },
      usage: {
        fetchedAt: Date.now(),
        stale: false,
        windows: [
          {
            label: 'Current session',
            kind: 'five_hour',
            percentUsed: index === 0 ? 100 : 26,
            resetsAt: Date.now() + 2.2 * 3600_000,
          },
        ],
        contributing: null,
      },
      cooldownUntil: index === 0 ? Date.now() + 2.2 * 3600_000 : null,
    })),
  }
}
const mockConnectorAuthListeners = new Set<(push: ConnectorAuthPush) => void>()
const mockClaudeLoginListeners = new Set<(state: never) => void>()
const mockAccountListeners = new Set<(view: AccountView) => void>()
let mockAccountTimer: ReturnType<typeof setTimeout> | undefined
let mockAccount: AccountView['account'] = { status: 'signed-out' }

/** The Phosphor account, signed in after a pretend browser round trip. */
function mockAccountView(): AccountView {
  const mode = localStorage.getItem('mock:accountState')
  if (mode === 'signing-in') return { account: { status: 'signing-in' } }
  if (mode === 'signed-in')
    return {
      account: {
        status: 'signed-in',
        user: { login: 'octo', name: 'Octo Cat', email: 'octo@example.com' },
        remembered: true,
      },
    }
  return { account: mockAccount }
}

function setMockAccount(next: AccountView['account']): AccountView {
  localStorage.removeItem('mock:accountState')
  mockAccount = next
  const view = mockAccountView()
  for (const listener of mockAccountListeners) listener(view)
  return view
}
// Browser-only visual fixtures. Electron never imports this module.
let harnessAdded: MachineView | null = null
const harnessRemoved = new Set<string>()
const harnessLabels = new Map<string, string>()
function harnessMachine(id: string, label: string, lastSeenAt: string | null): MachineView {
  return {
    id,
    label,
    hostname: label,
    platform: 'linux',
    arch: 'x64',
    hostVersion: '0.2.0',
    keyFingerprint: '0123-4567-89ab-cdef',
    enrolledAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    lastSeenAt,
    state: lastSeenAt ? 'running' : null,
    readiness: lastSeenAt ? { pi: 'ok', claude: 'ok', tailscale: 'ok' } : null,
    lanes: { running: 0, waiting: 0 },
    endpoint: null,
  }
}
function harnessMachines(): MachineView[] {
  const mixed = localStorage.getItem('mock:machinesState') === 'mixed'
  const machines = mixed
    ? [
        {
          ...harnessMachine(
            '11111111-1111-4111-8111-111111111111',
            'buildbox',
            new Date().toISOString(),
          ),
          lanes: { running: 2, waiting: 1 },
        },
        harnessMachine(
          '22222222-2222-4222-8222-222222222222',
          'studio',
          new Date(Date.now() - 10800000).toISOString(),
        ),
        harnessMachine('33333333-3333-4333-8333-333333333333', 'new-host', null),
        {
          ...harnessMachine(
            '44444444-4444-4444-8444-444444444444',
            'testbox',
            new Date().toISOString(),
          ),
          readiness: { pi: 'ok', claude: 'signed-out', tailscale: 'stopped' },
        } satisfies MachineView,
      ]
    : []
  if (localStorage.getItem('mock:remoteMixed') === '1')
    machines.push(
      harnessMachine('55555555-5555-4555-8555-555555555555', 'sandbox', new Date().toISOString()),
    )
  if (harnessAdded) machines.push(harnessAdded)
  return machines
    .filter((machine) => !harnessRemoved.has(machine.id))
    .map((machine) => ({ ...machine, label: harnessLabels.get(machine.id) ?? machine.label }))
}
let mockClaudeLoginTimer: ReturnType<typeof setTimeout> | undefined

function emitClaudeLoginState(state: never): void {
  mockClaudeLoginListeners.forEach((listener) => listener(state))
}

const MOCK_MODELS = [
  {
    id: 'qwen-3.5-122b',
    name: 'Qwen 3.5 122b',
    api: 'openai-completions',
    provider: 'local-stark',
    reasoning: true,
    input: ['text'],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: 'claude-fable-5',
    name: 'Fable 5',
    api: 'anthropic-messages',
    provider: 'anthropic',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
]

/**
 * What a permission gate actually sends: a heredoc that writes a script,
 * plus the command that runs it. The `rm -rf` inside the heredoc body is the
 * interesting part — it is written to a file, not run, and the approval sheet
 * has to say so instead of shouting.
 */
const MOCK_DANGEROUS_COMMAND = [
  "cat > /tmp/reset-fixtures.sh <<'EOF'",
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '# wipe the fixture tree before regenerating it',
  'rm -rf /tmp/fixtures',
  'mkdir -p /tmp/fixtures',
  'for n in 1 2 3; do',
  '  printf \'fixture %s\\n\' "$n" > "/tmp/fixtures/$n.txt"',
  'done',
  'EOF',
  'chmod +x /tmp/reset-fixtures.sh',
  'sudo /tmp/reset-fixtures.sh && echo regenerated',
].join('\n')

function respond(command: RpcCommand): RpcResponse {
  switch (command.type) {
    case 'get_messages':
      return { type: 'response', command: 'get_messages', success: true, data: { messages: [] } }
    case 'get_state':
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: MOCK_MODELS[0],
          thinkingLevel: 'medium',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionId: 'mock-session',
          sessionName: 'Mock replay session',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      } as RpcResponse
    case 'get_available_models':
      return {
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: MOCK_MODELS },
      } as RpcResponse
    case 'get_commands':
      return {
        type: 'response',
        command: 'get_commands',
        success: true,
        data: {
          commands: [
            {
              name: 'session-name',
              description: 'Set or clear the session name',
              source: 'extension',
            },
            {
              name: 'phosphor-swarm',
              description: 'Toggle lane authorization',
              source: 'extension',
            },
            { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' },
            { name: 'skill:web-search', description: 'Search the web', source: 'skill' },
          ],
        },
      } as RpcResponse
    case 'get_available_thinking_levels':
      return {
        type: 'response',
        command: 'get_available_thinking_levels',
        success: true,
        data: { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
      } as RpcResponse
    case 'get_session_stats':
      return {
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          sessionId: 'mock-session',
          userMessages: 2,
          assistantMessages: 4,
          toolCalls: 3,
          toolResults: 3,
          totalMessages: 9,
          tokens: { input: 48200, output: 3150, cacheRead: 39000, cacheWrite: 4100, total: 94450 },
          cost: 0.0421,
          contextUsage: { tokens: 51350, contextWindow: 262144, percent: 20 },
        },
      } as RpcResponse
    case 'prompt':
      setTimeout(() => void replayFixture('mock-session-id'), 60)
      return { type: 'response', command: 'prompt', success: true } as RpcResponse
    case 'bash':
      return {
        type: 'response',
        command: 'bash',
        success: true,
        data: { output: 'mock output\n', exitCode: 0, cancelled: false, truncated: false },
      } as RpcResponse
    default:
      return { type: 'response', command: command.type, success: true } as RpcResponse
  }
}

/**
 * Sessions the harness pretends are on disk, one entry per folder the mock
 * claims to know about (`app:getPrefs` recents + `git:listWorktrees`).
 *
 * `cwd` is load-bearing: `sessions:list` filters on it, because the real
 * handler reads one session directory per workspace folder. Returning every
 * session for every folder duplicated each row inside the Phosphor group — the
 * worktree folder folds into its main repo, so the same `path` was keyed
 * twice and React logged "two children with the same key".
 */
const MOCK_DISK_SESSIONS: SessionMeta[] = [
  {
    path: '/mock/sessions/a.jsonl',
    sessionId: 'a',
    cwd: '/Users/dev/projects/phosphor',
    createdAt: '2026-08-01T10:00:00.000Z',
    name: 'Refactor auth module',
    firstUserText: 'Refactor the auth module to use the new token service',
    userMessages: 14,
    assistantMessages: 18,
    toolCalls: 42,
    totalTokens: 812_000,
    inputTokens: 96_000,
    outputTokens: 41_000,
    cacheReadTokens: 640_000,
    cacheWriteTokens: 35_000,
    cost: 1.24,
    headroomSavedTokens: 64_000,
    entryCount: 96,
    branchCount: 2,
    mtimeMs: Date.now() - 3600_000,
    lastActivityAt: '2026-08-03T09:00:00.000Z',
  },
  {
    path: '/mock/sessions/b.jsonl',
    sessionId: 'b',
    cwd: '/Users/dev/projects/phosphor',
    createdAt: '2026-07-28T15:00:00.000Z',
    firstUserText: 'Why is the vite build slow?',
    userMessages: 3,
    assistantMessages: 4,
    toolCalls: 9,
    totalTokens: 120_500,
    inputTokens: 22_000,
    outputTokens: 8_500,
    cacheReadTokens: 88_000,
    cacheWriteTokens: 2_000,
    cost: 0.31,
    headroomSavedTokens: 0,
    entryCount: 18,
    branchCount: 0,
    mtimeMs: Date.now() - 86_400_000 * 2,
    lastActivityAt: '2026-08-01T12:00:00.000Z',
  },
  {
    // Lives in the mock worktree from `git:listWorktrees`, so the sidebar
    // still exercises the worktree-folds-into-its-repo group and the "wt"
    // subtitle chip.
    path: '/mock/sessions/c.jsonl',
    sessionId: 'c',
    cwd: '/Users/dev/projects/phosphor/.phosphor/worktrees/fix-auth',
    createdAt: '2026-08-02T08:00:00.000Z',
    name: 'Fix the auth redirect loop',
    firstUserText: 'The login redirect loops on expired tokens',
    userMessages: 6,
    assistantMessages: 7,
    toolCalls: 15,
    totalTokens: 240_000,
    inputTokens: 38_000,
    outputTokens: 12_000,
    cacheReadTokens: 182_000,
    cacheWriteTokens: 8_000,
    cost: 0.52,
    headroomSavedTokens: 18_500,
    entryCount: 31,
    branchCount: 1,
    mtimeMs: Date.now() - 7200_000,
    lastActivityAt: '2026-08-02T11:30:00.000Z',
  },
  {
    // Second project group in the sidebar; without a session of its own the
    // "other" header is filtered out for having no rows.
    path: '/mock/sessions/d.jsonl',
    sessionId: 'd',
    cwd: '/Users/dev/projects/other',
    createdAt: '2026-07-20T09:00:00.000Z',
    name: 'Bump the CI image',
    firstUserText: 'Update the CI base image to node 22',
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 4,
    totalTokens: 46_000,
    inputTokens: 9_000,
    outputTokens: 3_000,
    cacheReadTokens: 33_000,
    cacheWriteTokens: 1_000,
    cost: 0.09,
    headroomSavedTokens: 0,
    entryCount: 9,
    branchCount: 0,
    mtimeMs: Date.now() - 86_400_000 * 9,
    lastActivityAt: '2026-07-20T10:00:00.000Z',
  },
]

function mockContextFiles(): ContextFilePrefs {
  try {
    return normalizeContextFilePrefs(JSON.parse(localStorage.getItem('mock:contextFiles') ?? '{}'))
  } catch {
    return normalizeContextFilePrefs(undefined)
  }
}

function mockStats(): Record<string, unknown> {
  const activityByDay: Record<string, number> = {}
  for (let i = 0; i < 120; i++) {
    if (Math.sin(i * 1.7) > 0.2) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      activityByDay[d.toISOString().slice(0, 10)] = Math.ceil(Math.abs(Math.sin(i)) * 30)
    }
  }
  return {
    sessionCount: 212,
    messages: 77_813,
    tokens: 33_100_000,
    cost: 148.2,
    savedTokens: 82_500,
    activeDays: 46,
    activityByDay,
  }
}

let mockFileClipboard = { paths: [] as string[], cut: false }
const mockFs = new Map<string, boolean>(
  [
    'src/',
    'electron/',
    'package.json',
    'README.md',
    'src/main.tsx',
    'src/App.tsx',
    'electron/main.ts',
  ].map(
    (name) =>
      [`/Users/dev/projects/phosphor/${name.replace(/\/$/, '')}`, name.endsWith('/')] as const,
  ),
)

function mockDir(dir: string): Array<Record<string, unknown>> {
  return [...mockFs]
    .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === dir)
    .map(([path, isDirectory]) => ({
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      isDirectory,
      relativePath: path.replace('/Users/dev/projects/phosphor/', ''),
    }))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
}

function mockFileContent(path: string): string {
  return `// ${path}\nexport function hello(): string {\n  return 'from mock'\n}\n`
}

/** The real matcher over the mock files' contents, with main's cap, so a result opens where it says. */
function mockSearch(request: WorkspaceSearchRequest): WorkspaceSearchResult {
  const compiled = compileSearch(request)
  if (compiled.status === 'invalid') return { ...EMPTY_SEARCH_RESULT, error: compiled.error }
  if (compiled.status === 'empty') return EMPTY_SEARCH_RESULT
  const root = request.workspacePath.replace(/\/$/, '') + '/'
  const paths = [...mockFs]
    .filter(([path, isDirectory]) => !isDirectory && path.startsWith(root))
    .map(([path]) => path.slice(root.length))
    .filter(compiled.wants)
    .sort()
  const files: FileSearchResult[] = []
  let matchCount = 0
  let more = false
  for (const path of paths) {
    const room = MAX_SEARCH_RESULTS - matchCount
    const matches = findLineMatches(mockFileContent(root + path), compiled.regex, room + 1)
    if (matches.length > room) {
      more = true
      matches.length = room
    }
    if (matches.length > 0) files.push({ path, matches })
    matchCount += matches.length
    if (more) break
  }
  return {
    files,
    matchCount,
    searchedFiles: paths.length,
    skippedFiles: 0,
    ...(more ? { stopped: 'results' as const } : {}),
  }
}

function mockTree(): Record<string, unknown> {
  return {
    sessionId: 'a',
    cwd: '/Users/dev/projects/phosphor',
    leafId: 'u4',
    entries: [
      {
        id: 'u1',
        parentId: null,
        type: 'message',
        role: 'user',
        preview: 'Refactor the auth module to use the new token service',
        timestamp: '2026-08-01T10:00:00Z',
      },
      {
        id: 'a1',
        parentId: 'u1',
        type: 'message',
        role: 'assistant',
        preview: 'Starting with the token service…',
        toolName: 'read, edit',
        timestamp: '2026-08-01T10:01:00Z',
      },
      {
        id: 't1',
        parentId: 'a1',
        type: 'message',
        role: 'toolResult',
        toolName: 'edit',
        timestamp: '2026-08-01T10:01:30Z',
      },
      {
        id: 'u2',
        parentId: 't1',
        type: 'message',
        role: 'user',
        preview: 'Actually use JWT rotation instead',
        timestamp: '2026-08-01T10:05:00Z',
      },
      {
        id: 'a2',
        parentId: 'u2',
        type: 'message',
        role: 'assistant',
        preview: 'Switching to JWT rotation…',
        timestamp: '2026-08-01T10:06:00Z',
      },
      {
        id: 'u3',
        parentId: 't1',
        type: 'message',
        role: 'user',
        preview: 'Add refresh-token support too',
        timestamp: '2026-08-01T11:00:00Z',
      },
      {
        id: 'a3',
        parentId: 'u3',
        type: 'message',
        role: 'assistant',
        preview: 'Adding refresh tokens…',
        toolName: 'edit, bash',
        timestamp: '2026-08-01T11:02:00Z',
      },
      {
        id: 'bs1',
        parentId: 'a3',
        type: 'branch_summary',
        summary: 'Explored JWT rotation on the abandoned branch.',
        timestamp: '2026-08-01T11:10:00Z',
      },
      {
        id: 'u4',
        parentId: 'bs1',
        type: 'message',
        role: 'user',
        preview: 'Now write the tests',
        timestamp: '2026-08-01T11:15:00Z',
      },
      {
        id: 'l1',
        parentId: 'u4',
        type: 'label',
        targetId: 'u2',
        label: 'jwt-experiment',
        timestamp: '2026-08-01T11:20:00Z',
      },
    ],
  }
}

/** Optimization tab state: toggling and start/stop work in the harness. */
let mockHeadroomEnabled = true
let mockHeadroomRunning = true

function mockHeadroomStatus(): Record<string, unknown> {
  return {
    enabled: mockHeadroomEnabled,
    installed: true,
    version: '0.37.0',
    binaryPath: '/mock/.local/bin/headroom',
    proxy: { running: mockHeadroomRunning, url: 'http://127.0.0.1:8787', owned: true },
  }
}

/**
 * Voice tab and composer microphone. Enabling "downloads" in a few steps;
 * a dictation returns a canned sentence whatever was said.
 */
let mockVoice: VoiceStatus = {
  prefs: DEFAULT_VOICE_PREFS,
  phase: 'off',
  receivedBytes: 0,
  totalBytes: 0,
}
const mockVoiceListeners = new Set<(status: VoiceStatus) => void>()

function setMockVoice(next: Partial<VoiceStatus>): VoiceStatus {
  mockVoice = { ...mockVoice, ...next }
  for (const listener of mockVoiceListeners) listener(mockVoice)
  return mockVoice
}

function setMockVoicePrefs(prefs: VoiceStatus['prefs']): VoiceStatus {
  if (!prefs.enabled) return setMockVoice({ prefs, phase: 'off', receivedBytes: 0, totalBytes: 0 })
  const totalBytes = VOICE_MODELS.find((m) => m.id === prefs.model)?.downloadBytes ?? 0
  ;[0.3, 0.7, 1].forEach((fraction, step) =>
    setTimeout(
      () =>
        setMockVoice(
          fraction === 1
            ? { phase: 'ready', receivedBytes: totalBytes }
            : { receivedBytes: Math.round(totalBytes * fraction) },
        ),
      600 * (step + 1),
    ),
  )
  return setMockVoice({ prefs, phase: 'downloading', receivedBytes: 0, totalBytes })
}

/** Fake package-job streams: invoke returns a jobId, output arrives shortly after. */
const mockJobListeners = new Map<
  string,
  { output: Array<(data: string) => void>; exit: Array<(code: number) => void> }
>()

function mockJobChannel(jobId: string): {
  output: Array<(data: string) => void>
  exit: Array<(code: number) => void>
} {
  let entry = mockJobListeners.get(jobId)
  if (!entry) {
    entry = { output: [], exit: [] }
    mockJobListeners.set(jobId, entry)
  }
  return entry
}

function runMockJob(lines: string[], exitCode = 0): { jobId: string } {
  const jobId = `mock-job-${Math.random().toString(36).slice(2, 8)}`
  lines.forEach((line, i) => {
    setTimeout(
      () => {
        mockJobChannel(jobId).output.forEach((fn) => fn(`${line}\n`))
      },
      150 * (i + 1),
    )
  })
  setTimeout(
    () => {
      mockJobChannel(jobId).exit.forEach((fn) => fn(exitCode))
      mockJobListeners.delete(jobId)
    },
    150 * (lines.length + 1),
  )
  return { jobId }
}

/** Best-effort: the web clipboard needs permission and offers png only. */
async function mockClipboardReadImage(): Promise<{ data: string; mimeType: string } | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      if (!item.types.includes('image/png')) continue
      const blob = await item.getType('image/png')
      return { data: bytesToBase64(await blob.arrayBuffer()), mimeType: 'image/png' }
    }
  } catch {
    // Permission refused or no clipboard: same as an empty one.
  }
  return null
}

/**
 * Best-effort clipboard image write for the browser harness. The async
 * clipboard accepts png/jpeg natively, so gif/webp/bmp are rasterized to
 * png first. Permission or type failures are swallowed — a copy attempt
 * must never crash the harness.
 */
async function mockClipboardWriteImage(image: { data: string; mimeType: string }): Promise<void> {
  const write = (mime: string, blob: Blob): Promise<void> =>
    navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
  try {
    if (image.mimeType === 'image/png' || image.mimeType === 'image/jpeg') {
      const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))
      await write(image.mimeType, new Blob([bytes], { type: image.mimeType }))
    } else {
      const img = new Image()
      img.src = `data:${image.mimeType};base64,${image.data}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d')?.drawImage(img, 0, 0)
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
          'image/png',
        ),
      )
      await write('image/png', png)
    }
  } catch {
    // Clipboard permission or an unsupported type.
  }
}

/** Context composition, as the bundled extension would report it. */
const MOCK_CONTEXT_BREAKDOWN = JSON.stringify({
  totalTokens: 51350,
  contextWindow: 262144,
  parts: { messages: 41000, systemPrompt: 4200, tools: 5200, mcpTools: 2600 },
  counts: { tools: 6, mcpTools: 4, messages: 9 },
  // Codemode servers carry no schemas; one with direct tools does — see docs/mcp.md.
  mcpByServer: {
    braintrust: { tokens: 0, count: 0, toolCount: 34 },
    fellow: { tokens: 0, count: 0, toolCount: 12 },
    linear: { tokens: 2600, count: 4, toolCount: 61 },
    notion: { tokens: 0, count: 0, toolCount: 19 },
  },
  contextFiles: {
    off: [],
    files: [
      {
        path: '/Users/demo/projects/phosphor/CLAUDE.md',
        kind: 'claude',
        tokens: 5500,
        included: true,
      },
    ],
  },
  approximate: true,
})

const mockLearnedPrompts: string[] = [
  'ok good lets open a PR for this',
  'ok good lets open a PR and wait for checks',
  'run the tests and fix whatever breaks',
  'can you review the diff for bugs and regressions',
]

export function installMockPhosphor(): void {
  const api: PhosphorApi = {
    // The browser harness has no Electron; report the real host so key hints
    // in `npm run dev:web` match the machine the developer is sitting at.
    platform: navigator.userAgent.includes('Mac')
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux',

    invoke: (channel: string, ...args: unknown[]) => {
      if (channel.startsWith('routines:')) {
        if (args.some((arg) => typeof arg === 'string' && arg.startsWith('host:')))
          return Promise.reject(
            new Error('Machine routines are unavailable in the browser harness.'),
          )
        return mockRoutineCall(channel, args)
      }
      switch (channel) {
        case 'pi:health':
          return Promise.resolve({
            ok: true,
            version: MIN_PI_VERSION,
            binaryPath: '/mock/pi',
            minVersion: MIN_PI_VERSION,
          })
        case 'app:getPrefs':
          return Promise.resolve({
            theme: DEFAULT_APP_PREFS.theme,
            recentWorkspaces: [
              { path: '/Users/dev/projects/phosphor', name: 'phosphor', lastOpenedAt: Date.now() },
              {
                path: '/Users/dev/projects/other',
                name: 'other',
                lastOpenedAt: Date.now() - 8.64e7,
              },
            ],
            pinnedSessions: [],
            rewoundSessions: {},
            sessionOrder: JSON.parse(localStorage.getItem('mock:sessionOrder') ?? '[]'),
            modelPicks: {
              starred: ['anthropic/claude-opus-5'],
              recent: ['anthropic/claude-sonnet-5'],
              groupMode: 'family' as const,
            },
            collapsedWorkspaces: [],
            // Session "b" has activity newer than its marker → unseen pill.
            seenSessions: { '/mock/sessions/b.jsonl': Date.parse('2026-08-01T00:00:00.000Z') },
            fonts: {
              uiScale: 1,
              chatFontSize: 14.5,
              editorFontSize: 12.5,
              terminalFontSize: 12.5,
              monoFont: 'JetBrains Mono',
            },
            // DirectivesSection reads both of these straight into state, so
            // omitting them made the whole section throw in the harness.
            agentDirectives: DEFAULT_APP_PREFS.agentDirectives,
            agentDirectivesByProject: {},
            worktrees: DEFAULT_APP_PREFS.worktrees,
            contextBudget: localStorage.getItem('mock:contextBudget') ?? '',
            contextFiles: mockContextFiles(),
          })
        case 'app:setContextFile':
          localStorage.setItem(
            'mock:contextFiles',
            JSON.stringify({ ...mockContextFiles(), [args[0] as string]: args[1] === true }),
          )
          return Promise.resolve(undefined)
        case 'app:setContextBudget':
          localStorage.setItem('mock:contextBudget', (args[0] as string).trim())
          return Promise.resolve(undefined)
        case 'app:setSessionOrder':
          localStorage.setItem('mock:sessionOrder', JSON.stringify(args[0]))
          return Promise.resolve(undefined)
        case 'app:setModelPicks':
          return Promise.resolve(undefined)
        // Drafts in the browser harness are in-memory only: there is no main
        // process to persist them to, and a fake blob store would only hide
        // that.
        case 'app:setDraft':
        case 'app:clearDraft':
          return Promise.resolve(undefined)
        case 'app:writeDraftBlob':
          return Promise.resolve(true)
        case 'app:readDraftBlob':
          return Promise.resolve(null)
        case 'app:sweepDrafts':
          return Promise.resolve({})
        case 'app:setWorktreePrefs':
          return Promise.resolve(undefined)
        case 'app:setAgentDirectives':
          return Promise.resolve(undefined)
        case 'app:selectFolder':
          return Promise.resolve('/Users/dev/projects/phosphor')
        case 'app:createSandbox':
          return Promise.resolve('/Users/dev/sandboxes/quiet-otter')
        case 'app:listSandboxes':
          return Promise.resolve([
            {
              path: '/Users/dev/sandboxes/quiet-otter',
              name: 'quiet-otter',
              itemCount: 0,
              lastUsedAt: Date.now() - 3_600_000,
            },
          ])
        case 'app:renameSandbox':
          // Mirrors main's contract: a sandbox's path changes with its name.
          return Promise.resolve({
            ok: true,
            path: `/Users/dev/sandboxes/${String(args[1]).trim()}`,
          })
        case 'app:deleteSandbox':
          return Promise.resolve({ ok: true })
        case 'pi:createSession':
          // The bundled context-breakdown extension publishes on
          // session_start; mirror that so the meter has data in the harness.
          setTimeout(() => {
            push('mock-session-id', {
              kind: 'extension-ui',
              request: {
                type: 'extension_ui_request',
                id: 'mock-swarm',
                method: 'setStatus',
                statusKey: 'phosphor-swarm',
                statusText: JSON.stringify({
                  version: 1,
                  available: true,
                  enabled: false,
                  requested: false,
                }),
              },
            } as SessionPush)
            push('mock-session-id', {
              kind: 'extension-ui',
              request: {
                type: 'extension_ui_request',
                id: 'mock-ctx',
                method: 'setStatus',
                statusKey: 'phosphor-context-breakdown',
                statusText: MOCK_CONTEXT_BREAKDOWN,
              },
            } as SessionPush)
            push('mock-session-id', {
              kind: 'extension-ui',
              request: {
                type: 'extension_ui_request',
                id: 'mock-rl',
                method: 'setStatus',
                statusKey: 'claude-rate-limit',
                // Shaped like provider >= 0.4.9, which forwards `utilization`.
                // 0.62 exercises the ordinary case: a real bar, under the
                // warning threshold, so the harness shows what most sessions
                // look like rather than only the alarming state.
                statusText: JSON.stringify({
                  status: 'allowed',
                  resetsAt: Math.floor(Date.now() / 1000) + 8640,
                  rateLimitType: 'five_hour',
                  overageStatus: 'rejected',
                  isUsingOverage: false,
                  utilization: 0.62,
                  surpassedThreshold: null,
                }),
              },
            } as SessionPush)
            // The bundled headroom extension pushes this only once it has
            // actually compressed a result; the harness shows the section it
            // produces, including the lossy-skip row.
            push('mock-session-id', {
              kind: 'extension-ui',
              request: {
                type: 'extension_ui_request',
                id: 'mock-headroom',
                method: 'setStatus',
                statusKey: 'phosphor-headroom',
                statusText: JSON.stringify({
                  savedTokens: 12_400,
                  beforeTokens: 48_000,
                  afterTokens: 35_600,
                  results: 37,
                  skippedLossyTokens: 2100,
                  lastMs: 118,
                }),
              },
            } as SessionPush)
          }, 120)
          return Promise.resolve({
            sessionId: 'mock-session-id',
            workspacePath: '/Users/dev/projects/phosphor',
            pid: 1234,
          })
        case 'pi:command': {
          const command = args[1] as RpcCommand
          if (command.type === 'prompt' && /^\/phosphor-swarm (on|off)$/.test(command.message)) {
            const enabled = command.message.endsWith(' on')
            push(String(args[0]), {
              kind: 'extension-ui',
              request: {
                type: 'extension_ui_request',
                id: 'mock-swarm',
                method: 'setStatus',
                statusKey: 'phosphor-swarm',
                statusText: JSON.stringify({
                  version: 1,
                  available: true,
                  enabled,
                  requested: enabled,
                }),
              },
            } as SessionPush)
            return Promise.resolve({ type: 'response', command: 'prompt', success: true })
          }
          // Permission-gate rehearsal. The harness has no pi and therefore no
          // extension, but the dangerous-command approval sheet is the one
          // dialog whose whole point is how it renders a big ugly command —
          // so `danger` in a prompt raises a real one to look at.
          if (command.type === 'prompt' && /^\s*danger\b/i.test(command.message)) {
            setTimeout(() => {
              push('mock-session-id', {
                kind: 'extension-ui',
                request: {
                  type: 'extension_ui_request',
                  id: 'mock-danger',
                  method: 'select',
                  title: `Dangerous command:\n\n  ${MOCK_DANGEROUS_COMMAND}\n\nAllow?`,
                  options: ['Yes', 'No'],
                },
              } as SessionPush)
            }, 150)
            return Promise.resolve({ type: 'response', command: 'prompt', success: true })
          }
          return Promise.resolve(respond(command))
        }
        case 'pi:generateTitle':
          return Promise.resolve('Mock Generated Title')
        case 'fs:listFiles':
          return Promise.resolve([
            'src/main.tsx',
            'src/app/App.tsx',
            'electron/main.ts',
            'libs/session-runtime/src/pi/rpc-client.ts',
            'package.json',
            'README.md',
          ])
        case 'pi:agentSettings':
          return Promise.resolve({
            defaultProvider: 'anthropic',
            defaultModel: 'claude-opus-5',
            defaultThinkingLevel: 'medium',
            packages: ['npm:pi-web-access', 'npm:pi-subagents'],
          })
        case 'skills:list':
          return Promise.resolve({
            probe: 'scan' as const,
            userRoot: '/mock/.pi/agent/skills',
            projectRoot: '/mock/workspace/.pi/skills',
            skills: [
              {
                name: 'snowflake-mcp',
                description: 'Write safe, scoped Snowflake SQL queries against the warehouse.',
                dir: '/mock/.pi/agent/skills/snowflake-mcp',
                scope: 'user' as const,
                source: 'scan',
                origin: 'top-level' as const,
                writable: true,
                borrowed: false,
                draft: false,
                files: [{ path: 'SKILL.md', size: 4495 }],
                totalSize: 4495,
                warnings: [],
              },
              {
                name: 'debug',
                description: 'Diagnose a failing Phosphor session outside-in.',
                dir: '/mock/workspace/.claude/skills/debug',
                scope: 'project' as const,
                source: 'scan',
                origin: 'top-level' as const,
                writable: false,
                borrowed: true,
                draft: false,
                files: [{ path: 'SKILL.md', size: 5905 }],
                totalSize: 5905,
                warnings: [],
              },
              {
                name: 'council-mode',
                description: 'Run a bounded supervisor-mediated advisor council.',
                dir: '/mock/.pi/agent/npm/node_modules/pi-subagents/skills/council-mode',
                scope: 'user' as const,
                source: 'npm:pi-subagents',
                origin: 'package' as const,
                writable: false,
                borrowed: false,
                draft: false,
                files: [{ path: 'SKILL.md', size: 3120 }],
                totalSize: 3120,
                warnings: [],
              },
            ],
          })
        case 'skills:readFile':
          return Promise.resolve({
            content: '---\nname: mock\ndescription: Mock skill\n---\n\n# Mock skill\n',
            binary: false,
            size: 64,
          })
        case 'skills:create':
        case 'skills:importConfirm':
          return Promise.resolve({ dir: '/mock/.pi/agent/skills/new-skill' })
        case 'skills:install':
          return Promise.resolve({ dir: '/mock/.pi/agent/skills/installed', fileCount: 1 })
        case 'skills:restoreBundled':
        case 'skills:writeFile':
        case 'skills:delete':
          return Promise.resolve(undefined)
        case 'skills:export':
        case 'skills:importPick':
          return Promise.resolve(null)
        case 'packages:list':
          return Promise.resolve([
            {
              spec: 'npm:@saccolabs/pi-claude-cli',
              scope: 'global',
              kind: 'npm',
              filtered: false,
              name: 'pi-claude-cli',
              version: '0.5.0',
              description: 'Claude Code CLI as a pi model provider',
              installed: true,
              installPath: '/mock/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli',
              resources: { extensions: ['index.ts'], skills: [], prompts: [], themes: [] },
            },
            {
              spec: 'npm:pi-web-access',
              scope: 'global',
              kind: 'npm',
              filtered: false,
              name: 'pi-web-access',
              version: '0.9.2',
              description: 'Web search, URL fetching and PDF extraction for pi',
              installed: true,
              installPath: '/mock/.pi/agent/npm/node_modules/pi-web-access',
              resources: { extensions: ['index.ts'], skills: [], prompts: [], themes: [] },
            },
            {
              spec: 'npm:pi-subagents',
              scope: 'global',
              kind: 'npm',
              filtered: false,
              name: 'pi-subagents',
              version: '0.74.0',
              description: 'Single-agent delegation and scripted multi-agent workflows',
              installed: true,
              installPath: '/mock/.pi/agent/npm/node_modules/pi-subagents',
              resources: {
                extensions: ['index.js'],
                skills: ['council-mode', 'pi-subagents'],
                prompts: ['council', 'parallel-review', 'review-loop'],
                themes: [],
              },
            },
          ])
        case 'packages:run':
          return Promise.resolve(
            runMockJob([
              `$ pi ${String(args[0])} ${String(args[1] ?? '')}`.trim(),
              'Installing…',
              'Installed.',
            ]),
          )
        case 'packages:installPi':
          return Promise.resolve(
            runMockJob(['$ npm install -g @earendil-works/pi-coding-agent', 'added 120 packages']),
          )
        case 'packages:checkUpdates':
          // One package behind, one current — exercises both row states.
          return Promise.resolve({
            'npm:pi-web-access': '0.9.2',
            'npm:pi-subagents': '0.75.0',
          })
        case 'packages:detect':
          return Promise.resolve({ claude: true })
        case 'packages:claudeCliLatest':
          // Ahead of the mocked claudeStatus version, so the update row shows.
          return Promise.resolve('2.1.258')
        case 'packages:updateClaudeCli':
          return Promise.resolve(
            runMockJob(['$ claude update', 'Updated to 2.1.258 (from 2.1.219)']),
          )
        case 'packages:claudeStatus':
          return Promise.resolve({
            binary: { found: true, path: '/usr/local/bin/claude', version: '2.1.219' },
            auth: {
              ok: true,
              loggedIn: mockClaudeAuth.loggedIn,
              method: mockClaudeAuth.loggedIn ? 'claude.ai' : undefined,
              email: mockClaudeAuth.email,
              plan: mockClaudeAuth.loggedIn ? 'max' : undefined,
            },
          } as never)
        case 'claude:usageSnapshot':
          // Shaped like a real 2.1.x capture: the 5-hour window under the
          // warning threshold, weekly past it, plus the contributing block.
          return Promise.resolve({
            ok: true,
            snapshot: {
              fetchedAt: Date.now(),
              stale: false,
              windows: [
                {
                  label: 'Current session',
                  kind: 'five_hour',
                  percentUsed: 26,
                  resetsAt: Date.now() + 2.2 * 3600_000,
                },
                {
                  label: 'Current week (all models)',
                  kind: 'weekly',
                  percentUsed: 50,
                  resetsAt: Date.now() + 3.1 * 3600_000,
                },
                {
                  label: 'Current week (Fable)',
                  kind: 'weekly_model',
                  percentUsed: 37,
                  resetsAt: Date.now() + 3.1 * 3600_000,
                },
              ],
              contributing:
                'Approximate, based on local sessions on this machine.\n\nLast 24h · 747 requests · 69 sessions\n  75% of your usage was at >150k context\n  30% of your usage was while 4+ sessions ran in parallel',
            },
          } as never)
        case 'claude:startLogin':
          clearTimeout(mockClaudeLoginTimer)
          emitClaudeLoginState({ phase: 'starting' } as never)
          mockClaudeLoginTimer = setTimeout(
            () =>
              emitClaudeLoginState({
                phase: 'awaiting-code',
                url: 'https://claude.com/cai/oauth/authorize?code=true',
              } as never),
            600,
          )
          return Promise.resolve(undefined as never)
        case 'claude:submitCode': {
          const code = String(args[0] ?? '')
          emitClaudeLoginState({ phase: 'finishing' } as never)
          clearTimeout(mockClaudeLoginTimer)
          // "bad" reproduces the CLI's retry: a rejected code re-prompts with a
          // fresh URL rather than ending the flow.
          mockClaudeLoginTimer = setTimeout(() => {
            if (code === 'bad') {
              emitClaudeLoginState({
                phase: 'awaiting-code',
                url: 'https://claude.com/cai/oauth/authorize?code=true&retry=1',
                invalidCode: true,
              } as never)
            } else {
              mockClaudeAuth = { loggedIn: true, email: 'switched@example.com' }
              emitClaudeLoginState({ phase: 'signed-in', email: mockClaudeAuth.email } as never)
            }
          }, 900)
          return Promise.resolve(undefined as never)
        }
        case 'claude:accounts':
        case 'claude:refreshAccountUsage':
          return Promise.resolve(mockAccountViews() as never)
        case 'claude:removeAccount': {
          const id = String(args[0] ?? '')
          mockClaudeAccounts.prefs.accounts = mockClaudeAccounts.prefs.accounts.filter(
            (a) => a.id !== id,
          )
          return Promise.resolve(undefined as never)
        }
        case 'claude:reorderAccounts': {
          const ids = (args[0] ?? []) as string[]
          const byId = new Map(mockClaudeAccounts.prefs.accounts.map((a) => [a.id, a]))
          mockClaudeAccounts.prefs.accounts = ids.flatMap((id) => {
            const account = byId.get(id)
            return account ? [account] : []
          })
          return Promise.resolve(undefined as never)
        }
        case 'claude:setRouting':
          mockClaudeAccounts.prefs.mode = args[0] as 'specific' | 'ordered' | 'round-robin'
          if (args[1]) mockClaudeAccounts.prefs.pinnedId = String(args[1])
          return Promise.resolve(undefined as never)
        case 'claude:bindSession':
        case 'claude:assignSession':
          return Promise.resolve(undefined as never)
        // The harness only ever spawns one session, and it lands on the first
        // account — enough for the gateway view to list a lane and move it.
        case 'claude:accountSessions':
          return Promise.resolve({ default: ['mock-session-id'] } as never)
        case 'claude:sessionAccount':
          return Promise.resolve({
            id: 'default',
            label: 'dev@example.com',
            email: 'dev@example.com',
            total: 2,
            mode: mockClaudeAccounts.prefs.mode,
            cooldownUntil: Date.now() + 2.2 * 3600_000,
            alternative: { id: 'work', label: 'dev@work.example' },
          } as never)
        case 'claude:cancelLogin':
          clearTimeout(mockClaudeLoginTimer)
          emitClaudeLoginState({ phase: 'cancelled' } as never)
          return Promise.resolve(undefined as never)
        case 'claude:logout':
          mockClaudeAuth = { loggedIn: false }
          return Promise.resolve(undefined as never)
        case 'hosts:tailscaleStatus':
          return { code: 'not-installed' } as never
        case 'hosts:traffic':
          return mockTraffic(Number(args[0]) || 0)
        case 'hosts:reconnect':
          return undefined as never
        case 'hosts:settingsAccess':
        case 'hosts:settingsRead':
        case 'hosts:settingsPatch':
        case 'hosts:settingsCheck':
        case 'hosts:machineTask':
        case 'hosts:claudeAccount':
        case 'hosts:models':
        case 'hosts:claude':
        case 'hosts:claudeUsage':
        case 'hosts:providers':
          return mockMachineSettingsInvoke(channel, args) as never
        case 'hosts:repositoryFiles':
          return ['README.md', 'src/index.ts']
        case 'hosts:repositoryFile':
          return { binary: false, size: 20, content: '# Remote repository\n', revision: null }
        case 'hosts:skills':
          return { skills: [], probe: 'rpc', userRoot: `host:${args[0]}/machine` }
        case 'hosts:providerLogin':
          throw new Error('Provider sign-in needs a connected Host.')
        case 'hosts:uploadAttachments':
          throw new Error('Attachment uploads require a live Host.')
        case 'hosts:snapshot':
          return localStorage.getItem('mock:remoteLanes') === '1'
            ? localStorage.getItem('mock:remoteMixed') === '1'
              ? mixedRemoteHosts()
              : structuredClone(mockRemoteHosts)
            : {}
        case 'hosts:openLane':
        case 'hosts:createLane':
          if (localStorage.getItem('mock:remoteLanes') === '1')
            return Promise.resolve({
              ...mockRemoteInfo,
              target: { kind: 'remote', hostId: String(args[0]) },
              laneId: typeof args[1] === 'string' ? args[1] : mockRemoteInfo.laneId,
              workspacePath: `host:${String(args[0])}/0000000000000001`,
            })
          return Promise.reject(new Error('Remote lanes are not available in the browser harness.'))
        case 'hosts:setFocusedLane':
        case 'hosts:stopLane':
        case 'hosts:resumeLane':
        case 'hosts:takeControl':
        case 'hosts:markRead':
          if (localStorage.getItem('mock:remoteLanes') === '1') mockRemoteAction(channel)
          return Promise.resolve(undefined as never)
        // R1/R2 mock (B)
        case 'hosts:releaseControl':
          mockRemoteAction(channel)
          return Promise.resolve(undefined)
        case 'hosts:deleteLane':
          return Promise.resolve({ branchKept: false })
        case 'hosts:removeRepository':
        case 'hosts:createFolder':
          return Promise.resolve(undefined)
        case 'hosts:listFolders':
          return Promise.resolve({
            path: String(args[1] ?? ''),
            truncated: false,
            entries: [
              { name: 'Projects', isRepository: false, configured: false },
              { name: 'Phosphor', isRepository: true, configured: true },
              ...(args[2] ? [{ name: '.config', isRepository: false, configured: false }] : []),
            ],
          })
        case 'hosts:addRepository':
          return Promise.resolve({ repositoryId: '0000000000000002' })
        case 'control:machines':
          if (localStorage.getItem('mock:machinesState') === 'offline')
            return Promise.resolve({
              ok: false,
              error: { code: 'offline', message: 'Offline' },
            } as never)
          if (localStorage.getItem('mock:machinesState') === 'loading')
            return new Promise(() => undefined)
          return Promise.resolve(
            (mockAccountView().account.status === 'signed-in'
              ? { ok: true, machines: harnessMachines(), serverTime: new Date().toISOString() }
              : {
                  ok: false,
                  error: { code: 'signed-out', message: 'Sign in to Phosphor.' },
                }) as never,
          )
        case 'control:lookupEnrollment':
          return Promise.resolve(
            (mockAccountView().account.status !== 'signed-in'
              ? { ok: false, error: { code: 'signed-out' } }
              : args[0] === 'BCDFGHJK'
                ? {
                    ok: true,
                    hostname: 'buildbox',
                    platform: 'linux',
                    arch: 'x64',
                    hostVersion: '0.2.0',
                    keyFingerprint: '0123-4567-89ab-cdef',
                    expiresAt: new Date(Date.now() + 600000).toISOString(),
                  }
                : { ok: false, error: { code: 'not-found' } }) as never,
          )
        case 'control:approveEnrollment': {
          if (mockAccountView().account.status !== 'signed-in')
            return Promise.resolve({ ok: false, error: { code: 'signed-out' } } as never)
          const machine = harnessMachine(
            '55555555-5555-4555-8555-555555555555',
            String(args[1]),
            null,
          )
          harnessAdded = machine
          return Promise.resolve({ ok: true, machine } as never)
        }
        case 'control:renameMachine': {
          if (mockAccountView().account.status !== 'signed-in')
            return Promise.resolve({ ok: false, error: { code: 'signed-out' } } as never)
          harnessLabels.set(String(args[0]), String(args[1]))
          const machine = harnessMachines().find((entry) => entry.id === args[0])
          return Promise.resolve(
            (machine
              ? { ok: true, machine: { ...machine, label: String(args[1]) } }
              : { ok: false, error: { code: 'not-found' } }) as never,
          )
        }
        case 'control:removeMachine':
          harnessRemoved.add(String(args[0]))
          return Promise.resolve({ ok: true } as never)
        case 'account:get':
          return Promise.resolve(mockAccountView() as never)
        case 'account:signIn':
          mockAccountTimer = setTimeout(() => {
            const user = { login: 'octo', name: 'Octo Cat', email: 'octo@example.com' }
            setMockAccount({ status: 'signed-in', user, remembered: true })
          }, 1500)
          return Promise.resolve(setMockAccount({ status: 'signing-in' }) as never)
        case 'account:cancelSignIn':
          clearTimeout(mockAccountTimer)
          setMockAccount({ status: 'signed-out' })
          return Promise.resolve(undefined as never)
        case 'account:signOut':
          return Promise.resolve(setMockAccount({ status: 'signed-out' }) as never)
        case 'pi:webSearchConfig':
          return Promise.resolve({
            path: '/Users/dev/.pi/web-search.json',
            exists: true,
            malformed: false,
            config: { braveApiKey: 'BSA_mock', tavilyApiKey: '$TAVILY_API_KEY' },
          })
        case 'pi:patchWebSearchConfig':
          return Promise.resolve(undefined)
        case 'packages:testClaudeProvider':
          return Promise.resolve(
            runMockJob([
              '$ pi -p --model pi-claude-cli/claude-haiku-4-5 …',
              'phosphor-provider-ok',
            ]),
          )
        case 'mcp:readConfigs':
          return Promise.resolve({
            servers: [
              {
                name: 'linear',
                config: {
                  url: 'https://mcp.linear.app/mcp',
                  toolExposure: { get_issue: 'direct', save_issue: 'direct' },
                },
                defined: {
                  url: 'https://mcp.linear.app/mcp',
                  toolExposure: { get_issue: 'direct', save_issue: 'direct' },
                },
                scope: 'global',
              },
              {
                name: 'notion',
                config: { url: 'https://mcp.notion.com/mcp' },
                defined: { url: 'https://mcp.notion.com/mcp' },
                scope: 'global',
              },
              {
                name: 'snowflake',
                config: { command: 'npx', args: ['snowflake-mcp'], enabled: false },
                defined: { command: 'npx', args: ['snowflake-mcp'], enabled: false },
                scope: 'project',
              },
            ],
            files: [
              {
                scope: 'global',
                path: '/Users/dev/.pi/agent/mcp.json',
                exists: true,
                malformed: false,
                serverNames: ['linear', 'notion'],
              },
              {
                scope: 'project',
                path: '/Users/dev/projects/phosphor/.pi/mcp.json',
                exists: true,
                malformed: false,
                serverNames: ['snowflake'],
              },
            ],
            errors: [],
            projectTrust: {
              path: '/Users/dev/projects/phosphor',
              trusted: true,
              source: 'trust-store',
            },
            legacy: false,
          })
        case 'mcp:laneControl':
          return { ok: false, message: 'No native lane in the browser mock.' }
        case 'mcp:readChecks':
          return {}
        case 'mcp:cancelCheck':
        case 'mcp:setExposure':
          return undefined
        case 'mcp:checkServer':
          return mockMcpInspection(String(args[0]))
        case 'mcp:list':
          return mockMcpList()
        case 'mcp:authorize': {
          const serverName = String(args[0])
          const emit = (state: ConnectorAuthState): void => {
            for (const listener of mockConnectorAuthListeners) listener({ serverName, state })
          }
          emit({ phase: 'starting' })
          setTimeout(
            () =>
              emit({
                phase: 'awaiting-browser',
                authorizationUrl: `https://example.test/oauth/${serverName}`,
              }),
            300,
          )
          setTimeout(() => emit({ phase: 'connected' }), 2500)
          return undefined
        }

        case 'mcp:cancelAuth':
          return undefined

        case 'mcp:logout':
          return Promise.resolve({ ok: true, message: 'Signed out.' })

        case 'mcp:migrationPlan':
          return Promise.resolve({
            servers: [],
            skipped: [],
            retire: [],
            builtinDisabled: false,
            blocked: [],
          })

        case 'mcp:migrate':
          return Promise.resolve({ written: [], backups: [] })

        case 'mcp:upsertServer':
        case 'mcp:removeServer':
        case 'mcp:setEnabled':
        case 'mcp:writeFile':
          return Promise.resolve(undefined)
        case 'mcp:readFile':
          return Promise.resolve({
            path: '/Users/dev/.pi/agent/mcp.json',
            content: '{\n  "mcpServers": {}\n}\n',
          })
        // Shaped like a real pi answer: skills are `skill:<name>`, every entry
        // carries `sourceInfo`, and pi's own `/mcp` and `/llama` are built in —
        // so the menu's grouping and origin labels are exercised in the
        // browser harness.
        case 'pi:commands': {
          const pkg = (name: string, file: string) => ({
            path: `/Users/dev/.pi/agent/npm/node_modules/${name}/${file}`,
            source: `npm:${name}`,
            scope: 'user' as const,
            origin: 'package' as const,
            baseDir: `/Users/dev/.pi/agent/npm/node_modules/${name}`,
          })
          return Promise.resolve({
            commands: [
              {
                name: 'websearch',
                description: 'Open web search curator',
                source: 'extension' as const,
                sourceInfo: pkg('pi-web-access', 'index.ts'),
              },
              {
                name: 'mcp',
                description:
                  'Manage MCP servers: sign in, reconnect, enable or disable, and change exposure',
                source: 'extension' as const,
                sourceInfo: {
                  path: 'builtin:mcp',
                  source: 'builtin',
                  scope: 'temporary' as const,
                  origin: 'top-level' as const,
                },
              },
              {
                name: 'llama',
                description: 'Manage llama.cpp router models',
                source: 'extension' as const,
                sourceInfo: {
                  path: '<inline:llama.cpp>',
                  source: 'inline',
                  scope: 'temporary' as const,
                  origin: 'top-level' as const,
                },
              },
              {
                name: 'plan',
                description: 'Draft an implementation plan',
                source: 'prompt' as const,
                sourceInfo: {
                  path: '/Users/dev/.pi/agent/prompts/plan.md',
                  source: 'local',
                  scope: 'user' as const,
                  origin: 'top-level' as const,
                },
              },
              {
                name: 'skill:review',
                description: 'Review the working tree and report what would block a merge.',
                source: 'skill' as const,
                sourceInfo: {
                  path: '/mock/workspace/.claude/skills/review/SKILL.md',
                  source: 'local',
                  scope: 'project' as const,
                  origin: 'top-level' as const,
                },
              },
            ],
          })
        }
        case 'pi:catalogueModels':
          return Promise.resolve({
            source: 'pi',
            models: [
              {
                id: 'claude-opus-5',
                name: 'Opus 5',
                api: 'anthropic',
                provider: 'anthropic',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'high-boost', max: null },
                contextWindow: 200_000,
                maxTokens: 64_000,
                cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
                input: ['text', 'image'],
              },
              // The same model reached a second way. This pair is the whole
              // reason ModelMenu groups by family: two rows that read
              // identically until you look at the provider.
              {
                id: 'claude-opus-5',
                name: 'Opus 5',
                provider: 'pi-claude-cli',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'high-boost', max: null },
                contextWindow: 200_000,
                input: ['text', 'image'],
              },
              {
                id: 'claude-sonnet-5',
                name: 'Sonnet 5',
                api: 'anthropic',
                provider: 'anthropic',
                reasoning: true,
                thinkingLevelMap: null,
                contextWindow: 200_000,
                maxTokens: 64_000,
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                input: ['text', 'image'],
              },
              {
                id: 'Qwen 3.5 122b',
                name: 'Qwen 3.5 122b',
                provider: 'local-stark',
                reasoning: false,
                contextWindow: 128_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
              // Present so the harness can exercise the orchestrator's
              // malformed-tool-name warning: this is the model observed bricking
              // real threads (see features/orchestrator/threadHealth.ts).
              {
                id: 'minimax-m2',
                name: 'MiniMax M2',
                provider: 'amazon-bedrock',
                reasoning: false,
                thinkingLevelMap: null,
              },
              // Bedrock's real shape: a bare foundation id that cannot be invoked
              // on-demand, alongside the region-prefixed inference profiles that
              // can. Present so the harness exercises the disabled-row path in
              // ModelMenu (see lib/modelAvailability).
              {
                id: 'anthropic.claude-fable-5',
                name: 'Claude Fable 5',
                provider: 'amazon-bedrock',
                reasoning: true,
                thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
              },
              {
                id: 'us.anthropic.claude-fable-5',
                name: 'Claude Fable 5 (US)',
                provider: 'amazon-bedrock',
                reasoning: true,
                thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
              },
              {
                id: 'global.anthropic.claude-fable-5',
                name: 'Claude Fable 5 (Global)',
                provider: 'amazon-bedrock',
                reasoning: true,
                thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
              },
              {
                id: 'amazon.nova-pro-v1:0',
                name: 'Nova Pro',
                provider: 'amazon-bedrock',
                reasoning: false,
              },
            ],
          })
        case 'app:userInfo':
          return Promise.resolve({ username: 'dev', awsProfile: 'dev' })
        case 'app:setLastSession':
          return Promise.resolve(undefined)
        case 'app:resumeTarget':
          // Browser harness always starts at the picker.
          return Promise.resolve({ kind: 'none' })
        case 'pi:listLiveSessions':
          // The harness owns no real subprocesses, so there is nothing to
          // re-adopt after a reload.
          return Promise.resolve([])
        case 'pi:setActiveSession':
          return Promise.resolve(undefined)
        case 'app:setSessionReaperPrefs':
          return Promise.resolve(undefined)
        case 'sessions:setCompleted':
        case 'sessions:retainedWorkspaces':
        case 'sessions:restoreWorktree':
        case 'sessions:worktreeRecovery':
        case 'sessions:recreateWorktree':
        case 'sessions:list':
        case 'sessions:delete':
          return mockSessionMaintenance(channel, args, MOCK_DISK_SESSIONS)
        case 'sessions:stats':
          return Promise.resolve(mockStats())
        case 'headroom:status':
          return Promise.resolve(mockHeadroomStatus())
        case 'headroom:setEnabled':
          mockHeadroomEnabled = args[0] as boolean
          return Promise.resolve(mockHeadroomStatus())
        case 'headroom:start':
          mockHeadroomRunning = true
          return Promise.resolve(mockHeadroomStatus())
        case 'headroom:stop':
          mockHeadroomRunning = false
          return Promise.resolve(mockHeadroomStatus())
        case 'headroom:install':
          return Promise.resolve(
            runMockJob([
              'Resolved 34 packages in 1.2s',
              'Installed 34 packages in 8.4s',
              'Installed 1 executable: headroom',
            ]),
          )
        case 'voice:status':
          return Promise.resolve(mockVoice)
        case 'voice:setPrefs':
          return Promise.resolve(setMockVoicePrefs(args[0] as VoiceStatus['prefs']))
        case 'voice:start':
        case 'voice:audio':
        case 'voice:cancel':
          return Promise.resolve(undefined)
        case 'voice:stop':
          return Promise.resolve({ text: 'Run the tests and tell me what fails.' })
        case 'optimization:stats': {
          const workspacePath = args[0] as string
          const sessions = MOCK_DISK_SESSIONS.filter((m) => m.cwd === workspacePath)
          const withSavings = sessions.filter((m) => m.headroomSavedTokens > 0)
          return Promise.resolve({
            savedTokens: sessions.reduce((sum, m) => sum + m.headroomSavedTokens, 0),
            sessionsWithSavings: withSavings.length,
            sessionCount: sessions.length,
            lanes: withSavings
              .sort((a, b) => b.headroomSavedTokens - a.headroomSavedTokens)
              .map((m) => ({
                path: m.path,
                name: 'name' in m ? m.name : undefined,
                firstUserText: m.firstUserText,
                savedTokens: m.headroomSavedTokens,
                totalTokens: m.totalTokens,
              })),
            advisor: [
              {
                id: 'cache-churn',
                severity: 'serious',
                title: 'A lane is re-writing its context cache',
                detail:
                  '"Refactor auth module" re-wrote 54% of its cached context instead of reading it back. Check the installed pi-claude-cli version (0.7.0+ keeps one CLI process per session).',
                settingsTab: 'claude-provider',
              },
              {
                id: 'mcp-weight',
                severity: 'tip',
                title: '4 MCP servers are connected',
                detail:
                  'Each server adds its tool schemas to every request. Disconnect the ones this project does not use.',
                settingsTab: 'connectors',
              },
            ],
          })
        }
        case 'app:openExternal':
          return Promise.resolve(undefined)
        case 'clipboard:readFiles':
          return Promise.resolve(mockFileClipboard)
        case 'clipboard:writeFiles':
          mockFileClipboard = { paths: args[0] as string[], cut: args[1] as boolean }
          return Promise.resolve(undefined)
        case 'clipboard:writeImage':
          return mockClipboardWriteImage(args[0] as { data: string; mimeType: string })
        case 'clipboard:readImage':
          return mockClipboardReadImage()
        // Writing: no spellchecker and no clipboard here, but autocomplete can
        // learn in memory, seeded so the ghost text shows on a fresh harness.
        case 'writing:prompts':
          return Promise.resolve([...mockLearnedPrompts])
        case 'writing:recordPrompt':
          mockLearnedPrompts.push(String(args[0]).trim())
          return Promise.resolve(undefined)
        case 'writing:clearPrompts':
          mockLearnedPrompts.length = 0
          return Promise.resolve(undefined)
        case 'writing:learnWord':
          return Promise.resolve(false)
        case 'writing:setPrefs':
        case 'writing:edit':
          return Promise.resolve(undefined)
        case 'gh:available':
          return Promise.resolve(true)
        case 'gh:prForBranch':
          return Promise.resolve({
            number: 42,
            title: 'Composer attachments and worktree controls',
            state: 'OPEN',
            url: 'https://github.com/agustinsacco/Phosphor/pull/42',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            checks: { passed: 3, failed: 0, pending: 1, total: 4 },
          })
        case 'artifacts:stageHtml':
          // The browser harness has no custom protocol; a blob URL previews
          // the same content. It inherits the page CSP, so scripts stay
          // blocked here — only the packaged app runs artifact JS. The house
          // stylesheet is injected by the main process, so the harness shows
          // the model's markup unstyled; that difference is the point of the
          // Electron path, not a bug to paper over here.
          return Promise.resolve(
            URL.createObjectURL(new Blob([args[0] as string], { type: 'text/html' })),
          )
        case 'artifacts:exportPdf':
          // No Chromium print pipeline in the browser harness; the toolbar
          // flow (switch to preview, serialise, toast) is what this exercises.
          return Promise.resolve({
            savedTo: `/Users/you/Downloads/${(args[0] as { title: string }).title}.pdf`,
          })
        case 'artifacts:forSession':
          // Mock sessions carry no stored artifacts; live ones arrive as events.
          return Promise.resolve([])
        case 'artifacts:list':
          // One artifact from a deleted session, so the page's
          // "Session deleted" row and its read-only viewer are reachable.
          return Promise.resolve(mockStoredArtifactRemoved ? [] : [MOCK_STORED_ARTIFACT.listing])
        case 'artifacts:read':
          return Promise.resolve(
            !mockStoredArtifactRemoved && args[0] === MOCK_STORED_ARTIFACT.listing.key
              ? MOCK_STORED_ARTIFACT
              : null,
          )
        case 'artifacts:remove': {
          const removed = !mockStoredArtifactRemoved && args[0] === MOCK_STORED_ARTIFACT.listing.key
          mockStoredArtifactRemoved ||= removed
          return Promise.resolve(removed)
        }
        case 'app:setLanePrefs':
          return Promise.resolve(undefined)
        case 'app:setLaneMarkers':
          return Promise.resolve(undefined)
        case 'app:setRewoundSessions':
          return Promise.resolve(undefined)
        case 'gh:prsForRepo':
          // Branch keys must match the mock git:infoBatch branches below, or
          // the harness renders a sidebar with no PR chips at all.
          return Promise.resolve({
            complete: true,
            byBranch: {
              'fix/phase0-chat-ux': {
                number: 42,
                title: 'Composer attachments and worktree controls',
                state: 'OPEN',
                url: 'https://github.com/agustinsacco/Phosphor/pull/42',
                checks: { passed: 3, failed: 0, pending: 1, total: 4 },
                reviewDecision: 'APPROVED',
              },
              main: {
                number: 39,
                title: 'Lane loop removal',
                state: 'MERGED',
                url: 'https://github.com/agustinsacco/Phosphor/pull/39',
                checks: { passed: 4, failed: 0, pending: 0, total: 4 },
              },
            },
          })
        case 'git:info':
          return Promise.resolve({
            isRepo: true,
            branch: 'main',
            dirtyCount: 3,
            ahead: 1,
            behind: 0,
            isWorktree: false,
          })
        case 'git:infoBatch': {
          const cwds = args[0] as string[]
          return Promise.resolve(
            Object.fromEntries(
              cwds.map((cwd, i) => [
                cwd,
                i === 0
                  ? {
                      isRepo: true,
                      branch: 'fix/phase0-chat-ux',
                      dirtyCount: 2,
                      isWorktree: true,
                      // Worktree folders are commonly named after their branch
                      // (".../worktrees/main") — mainRepoPath exercises the
                      // "repo (branch)" sidebar label instead of that folder name.
                      mainRepoPath: '/Users/dev/projects/phosphor',
                    }
                  : { isRepo: true, branch: 'main', dirtyCount: 0, isWorktree: false },
              ]),
            ),
          )
        }
        case 'app:markSessionSeen':
          return Promise.resolve(undefined)
        case 'git:listWorktrees':
          return Promise.resolve([
            {
              path: '/Users/dev/projects/phosphor',
              realPath: '/Users/dev/projects/phosphor',
              branch: 'main',
              head: 'abcdef1234567890',
              isMain: true,
              locked: false,
              prunable: false,
              dirtyCount: 3,
            },
            {
              path: '/Users/dev/projects/phosphor/.phosphor/worktrees/fix-auth',
              realPath: '/Users/dev/projects/phosphor/.phosphor/worktrees/fix-auth',
              branch: 'fix-auth',
              head: '123456abcdef7890',
              isMain: false,
              locked: false,
              prunable: false,
              dirtyCount: 0,
            },
            {
              // Outside `.phosphor/worktrees`, so nothing about the path says
              // "worktree". It must still fold into the Phosphor group on the
              // first render, from the root this call was made against.
              path: '/tmp/phosphor-pr-4821',
              realPath: '/tmp/phosphor-pr-4821',
              branch: 'pr-4821',
              head: '9876fedcba543210',
              isMain: false,
              locked: false,
              prunable: false,
              dirtyCount: 1,
            },
            {
              // Folder deleted behind git's back. Never a sidebar group.
              path: '/Users/dev/projects/phosphor-gone',
              realPath: '/Users/dev/projects/phosphor-gone',
              branch: 'gone',
              head: '0000000000000000',
              isMain: false,
              locked: false,
              prunable: true,
              dirtyCount: -1,
            },
          ])
        case 'git:listBranches':
          return Promise.resolve({
            branches: [
              // `main` is deliberately NOT isCurrent: that is the state in which
              // the default branch looks "free" and used to be offered as a
              // worktree, which is what permanently locked the main tree out of
              // it. The menu must exclude it on defaultBranch alone.
              // Deliberately behind its upstream: this is the state the branch
              // menu has to advertise with "Pull latest", so the harness must
              // be able to render it without a real remote.
              {
                name: 'main',
                isCurrent: false,
                lastCommitSubject: 'latest work',
                upstream: 'origin/main',
                ahead: 0,
                behind: 3,
                behindDefault: 0,
              },
              {
                name: 'fix-auth',
                isCurrent: false,
                worktreePath: '/Users/dev/projects/phosphor/.phosphor/worktrees/fix-auth',
                lastCommitSubject: 'wip',
                behindDefault: 3,
              },
              {
                name: 'feature/usage-view',
                isCurrent: true,
                lastCommitSubject: 'usage modal',
                upstream: 'origin/feature/usage-view',
                ahead: 2,
                behind: 0,
                behindDefault: 5,
              },
              { name: 'chore/deps', isCurrent: false, lastCommitSubject: 'bump vite' },
            ],
            defaultBranch: 'main',
          })
        case 'git:startPoint':
          return Promise.resolve({ base: 'origin/main', defaultBranch: 'main', fromRemote: true })
        case 'git:addWorktree': {
          // Auto-created session branches carry a prefix the folder cannot, so
          // the harness has to echo the requested branch rather than the folder.
          const branch = args[2] as { kind: string; branch?: string }
          return Promise.resolve({
            path: `/Users/dev/projects/phosphor/.phosphor/worktrees/${args[1] as string}`,
            realPath: `/Users/dev/projects/phosphor/.phosphor/worktrees/${args[1] as string}`,
            branch: branch.branch ?? (args[1] as string),
            head: 'abcdef1234567890',
            isMain: false,
            locked: false,
            prunable: false,
            dirtyCount: 0,
          })
        }
        case 'git:removeWorktree':
          return Promise.resolve({ removed: true, branchDeleted: false })
        case 'git:renameBranch':
          return Promise.resolve({ renamed: true, branch: args[2] as string })
        case 'maintenance:scan':
        case 'maintenance:run':
          return [
            {
              ranAt: Date.now(),
              workspacePath: '/Users/dev/projects/phosphor',
              worktreeCount: 3,
              candidates: [
                {
                  path: '/repo/.phosphor/worktrees/merged-lane',
                  branch: 'phosphor/merged-lane',
                  bytes: 980 * 1024 * 1024,
                  reason: 'merged',
                },
              ],
              held: [
                { path: '/repo', branch: 'main', reason: 'main-checkout' },
                {
                  path: '/repo/.phosphor/worktrees/busy',
                  branch: 'phosphor/busy',
                  reason: 'dirty',
                },
              ],
              prunedRegistrations: [],
              reclaimed: [],
              reclaimableBytes: 980 * 1024 * 1024,
              reclaimedBytes: 0,
              liveSessionCount: 1,
              errors: [],
            },
          ]
        case 'maintenance:setPrefs':
          return undefined
        case 'git:pruneWorktrees':
          return Promise.resolve({ pruned: [] })
        case 'git:commitAll':
          return Promise.resolve({ sha: 'abcdef1234567890' })
        case 'git:mergeBranch':
          return Promise.resolve({ merged: true, sha: 'abcdef1234567890' })
        case 'git:fetch':
          return Promise.resolve({ fetched: true, at: Date.now() })
        case 'git:pull':
          return Promise.resolve({ pulled: true, upstream: 'origin/main', commits: 3 })
        case 'git:updateFromMain':
          return Promise.resolve({ updated: true, commits: 3, sha: 'abcdef1234567890' })
        case 'git:checkoutBranch':
          return Promise.resolve({ checkedOut: true, branch: args[1] as string })
        case 'sessions:readTranscript':
          return Promise.resolve([{ role: 'user', content: 'Saved conversation' }])
        case 'sessions:readTree':
          return Promise.resolve(mockTree())
        // No provider sidecar here; debug falls back to the pi session id.
        case 'sessions:claudeSessionId':
          return Promise.resolve(null)
        // Same reason: no provider sidecar to fork in the browser harness.
        case 'sessions:forkClaudeLedger':
          return Promise.resolve(false)
        case 'fs:readDir': {
          const dir = args[1] as string
          return Promise.resolve(mockDir(dir))
        }
        case 'fs:readFile': {
          const path = args[0] as string
          return Promise.resolve({
            path,
            content: mockFileContent(path),
            size: 64,
            mtimeMs: Date.now(),
          })
        }
        case 'fs:searchWorkspace':
          return Promise.resolve(mockSearch(args[0] as WorkspaceSearchRequest))
        case 'fs:cancelWorkspaceSearch':
          return Promise.resolve(undefined)
        // There is no phosphor-file:// server in a plain browser, so viewers
        // fall back to their "open externally" card here.
        case 'fs:previewUrl':
          return Promise.reject(new Error('No file previews in the browser harness'))
        case 'fs:openInDefaultApp':
          return Promise.resolve({ ok: true })
        case 'fs:quickLook':
          return Promise.resolve(undefined)
        case 'fs:pickEntries':
          return Promise.resolve([])
        case 'fs:transfer': {
          const [, from, dir, mode] = args as [string, string, string, string]
          const to = dir + '/' + from.slice(from.lastIndexOf('/') + 1)
          if (mockFs.has(to)) return Promise.reject(new Error(`Already exists: ${to}`))
          if (!mockFs.has(from))
            return Promise.reject(new Error('Source is unavailable in browser preview'))
          for (const [path, directory] of [...mockFs]) {
            if (path !== from && !path.startsWith(from + '/')) continue
            mockFs.set(to + path.slice(from.length), directory)
            if (mode === 'move') mockFs.delete(path)
          }
          return Promise.resolve(to)
        }
        case 'fs:createFile':
        case 'fs:createDir': {
          const path = args[0] as string
          if (mockFs.has(path)) return Promise.reject(new Error(`Already exists: ${path}`))
          mockFs.set(path, channel === 'fs:createDir')
          return Promise.resolve(undefined)
        }
        case 'fs:rename':
        case 'fs:trash': {
          const [from, to] = args as [string, string]
          if (to && mockFs.has(to)) return Promise.reject(new Error(`Already exists: ${to}`))
          for (const [path, directory] of [...mockFs]) {
            if (path !== from && !path.startsWith(from + '/')) continue
            mockFs.delete(path)
            if (to) mockFs.set(to + path.slice(from.length), directory)
          }
          return Promise.resolve(undefined)
        }
        case 'fs:writeFile':
          return Promise.resolve({ mtimeMs: Date.now() })
        case 'git:statusMap':
          return Promise.resolve({ 'src/main.tsx': ' M', 'README.md': '??' })
        case 'git:sessionBaseline':
          return Promise.resolve(null)
        case 'git:showFileAt':
          return Promise.resolve('// baseline content\n')
        case 'updates:state':
          return Promise.resolve({ phase: 'idle' })
        case 'updates:check':
        case 'updates:restartAndInstall':
          return Promise.resolve(undefined)
        // Nudged on purpose: the harness exists to render the states that are
        // hard to reach, and this one takes three days of real use.
        case 'feedback:state':
          return Promise.resolve({ mode: 'github', nudge: true, repo: 'agustinsacco/Phosphor' })
        case 'feedback:submit':
          return Promise.resolve({ ok: true, mode: 'github', url: 'https://github.com/' })
        case 'feedback:dismiss':
          return Promise.resolve(undefined)
        case 'fs:statDirs':
          return Promise.resolve((args[0] as string[]).map((path) => ({ path, mtimeMs: 1 })))
        case 'fs:watchWorkspace':
        case 'sessions:watch':
        case 'sessions:unwatch':
          return Promise.resolve(undefined)
        case 'pty:create': {
          const ptyId = 'mock-pty-' + Math.random().toString(36).slice(2, 8)
          setTimeout(() => {
            for (const l of ptyListeners.get(ptyId) ?? []) l('mock shell — echo only\r\n$ ')
          }, 120)
          return Promise.resolve({ ptyId })
        }
        case 'pty:write': {
          const [ptyId, data] = args as [string, string]
          const echo = data.replace(/\r/g, '\r\n$ ')
          for (const l of ptyListeners.get(ptyId) ?? []) l(echo)
          return Promise.resolve(undefined)
        }
        case 'pty:attach':
          return Promise.resolve({ scrollback: '' })
        case 'pty:resize':
        case 'pty:kill':
          return Promise.resolve(undefined)
        case 'pi:readConfigFile':
          return Promise.resolve({
            path: '/Users/dev/.pi/agent/settings.json',
            content: '{\n  "defaultThinkingLevel": "medium"\n}\n',
          })
        case 'pi:listResources':
          return Promise.resolve({
            skills: ['brave-search', 'web-fetch'],
            extensions: ['session.ts', 'rpc-demo.ts'],
            prompts: ['fix-tests.md'],
            themes: ['gruvbox.json'],
          })
        case 'pi:codexUsage':
          return {
            ok: true,
            snapshot: {
              fetchedAt: Date.now(),
              windows: [
                {
                  label: 'Weekly',
                  kind: 'weekly',
                  percentUsed: 47,
                  resetsAt: Date.now() + 3 * 86_400_000,
                },
              ],
              credits: { limit: 200, remaining: 57, resetsAt: Date.now() + 21 * 86_400_000 },
            },
          }
        // One of each state, so the Accounts tab's three badges are all
        // reachable in the browser harness without a pi install.
        case 'pi:subscriptionAuth':
          return Promise.resolve(
            MOCK_PROVIDERS.map(({ defaultState, ...p }) => ({
              ...p,
              ...(mockAuthState[p.id] ?? defaultState),
            })) as never,
          )
        case 'pi:loginTerminal':
          return Promise.resolve({ ptyId: 'mock-login-pty' })
        // Replays the real flow's phases so the Accounts tab — device code,
        // cancel, the row flipping to "Signed in" — is developable without pi.
        case 'pi:startLogin': {
          const providerId = args[0] as string
          mockLoginTimers.forEach(clearTimeout)
          mockLoginTimers = [
            setTimeout(() => emitLoginState({ providerId, phase: 'starting' } as never), 300),
            setTimeout(
              () =>
                emitLoginState({
                  providerId,
                  phase: 'awaiting-browser',
                  url: 'https://example.com/oauth2/device?user_code=8G95-72AD',
                  userCode: '8G95-72AD',
                } as never),
              1200,
            ),
            setTimeout(() => {
              mockAuthState[providerId] = { status: 'ready' }
              emitLoginState({ providerId, phase: 'signed-in' } as never)
            }, 6000),
          ]
          return Promise.resolve(undefined as never)
        }
        case 'pi:cancelLogin': {
          mockLoginTimers.forEach(clearTimeout)
          mockLoginTimers = []
          emitLoginState({ providerId: args[0], phase: 'cancelled' } as never)
          return Promise.resolve(undefined as never)
        }
        // Without this the Agent tab threw on `result.global` before any of
        // it rendered — the channel had no case and the default returns
        // undefined.
        case 'pi:checkAgentSettings':
          return Promise.resolve({
            global: { exists: true, malformed: false },
            project: args[0] ? { exists: false, malformed: false } : null,
          })
        case 'pi:agentSettingsScoped':
          return Promise.resolve({
            global: {
              defaultProvider: 'anthropic',
              defaultModel: 'claude-opus-5',
              defaultThinkingLevel: 'medium',
              packages: ['npm:pi-web-access', 'npm:pi-subagents'],
            },
            project: args[0] ? { defaultThinkingLevel: 'high' } : null,
          })
        case 'pi:patchAgentSettings':
        case 'pi:writeConfigFile':
        case 'app:setFontPrefs':
        case 'app:setRecentWorkspaces':
        case 'app:setCollapsedWorkspaces':
        case 'app:recordWorkspace':
        case 'app:revealDebugLog':
          return Promise.resolve(undefined)
        // The browser harness has no main process and so no log file.
        case 'app:debugLogPath':
          return Promise.resolve(null)
        default:
          return Promise.resolve(undefined)
      }
    },
    onSessionPush: (sessionId, listener) => {
      const set = listeners.get(sessionId) ?? new Set()
      set.add(listener)
      listeners.set(sessionId, set)
      return () => set.delete(listener)
    },

    onSessionsChanged: () => () => {},
    onRoutinesChanged: onMockRoutinesChanged,

    onPiCommandsChanged: () => () => {},

    onFsChanged: () => () => {},
    onPackagesJobOutput: (jobId: string, listener: (data: string) => void) => {
      const entry = mockJobChannel(jobId)
      entry.output.push(listener)
      return () => {
        entry.output = entry.output.filter((fn) => fn !== listener)
      }
    },
    onPackagesJobExit: (jobId: string, listener: (exitCode: number) => void) => {
      const entry = mockJobChannel(jobId)
      entry.exit.push(listener)
      return () => {
        entry.exit = entry.exit.filter((fn) => fn !== listener)
      }
    },
    onPtyData: (ptyId: string, listener: (data: string) => void) => {
      const set = ptyListeners.get(ptyId) ?? new Set()
      set.add(listener)
      ptyListeners.set(ptyId, set)
      return () => set.delete(listener)
    },
    onPtyExit: () => () => {},
    onPtyStatus: () => () => {},

    // Connector authorization: the browser harness cannot spawn pi, so the
    // flow is replayed on a timer. Enough to develop the card without an app.
    onMcpAuthState: (listener) => {
      mockConnectorAuthListeners.add(listener)
      return () => mockConnectorAuthListeners.delete(listener)
    },

    onPiLoginState: (listener) => {
      mockLoginListeners.add(listener)
      return () => mockLoginListeners.delete(listener)
    },

    onClaudeLoginState: (listener) => {
      mockClaudeLoginListeners.add(listener)
      return () => mockClaudeLoginListeners.delete(listener)
    },

    onHostsChanged: onMockRemoteChanged,
    onHostAttention: () => () => undefined,
    onHostOpenLane: () => () => undefined,
    onMachinesChanged: () => () => undefined,

    onVoiceStatus: (listener) => {
      mockVoiceListeners.add(listener)
      return () => mockVoiceListeners.delete(listener)
    },

    onAccountChanged: (listener) => {
      mockAccountListeners.add(listener)
      return () => mockAccountListeners.delete(listener)
    },

    // Replay a full update lifecycle so the pill is developable in the
    // browser harness. Timings are compressed; the real one polls every 30min.
    onUpdateEvent: (listener) => {
      const steps: Array<[number, Parameters<typeof listener>[0]]> = [
        [1500, { phase: 'checking' }],
        [2500, { phase: 'downloading', version: '0.1.42', progressPercent: 12 }],
        [3300, { phase: 'downloading', version: '0.1.42', progressPercent: 58 }],
        [4100, { phase: 'downloading', version: '0.1.42', progressPercent: 91 }],
        [4800, { phase: 'downloaded', version: '0.1.42' }],
      ]
      const timers = steps.map(([delay, state]) => setTimeout(() => listener(state), delay))
      return () => timers.forEach(clearTimeout)
    },

    // The browser harness has no Electron, so there is no real path — files
    // dropped here are rejected by toAttachment rather than half-attached.
    pathForFile: () => '',
    // No Chromium spellchecker without Electron: every word reads as correct.
    spellingSuggestions: () => null,
    piCommand: (sessionId, command) =>
      (api.invoke as (c: string, ...a: unknown[]) => Promise<never>)(
        'pi:command',
        sessionId,
        command,
      ),
  } as PhosphorApi

  window.phosphor = api
  console.info('[Phosphor] mock preload API installed (browser dev mode)')
}
