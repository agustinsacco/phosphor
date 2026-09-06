/**
 * Dev-only mock of the preload API so the renderer can run in a plain
 * browser (vite dev server without Electron). Replays the captured real
 * pi event stream with realistic pacing. Never bundled in production:
 * loaded lazily behind `import.meta.env.DEV && !window.pidex`.
 */
import type { PidexApi } from '@shared/ipc'
import type { ConnectorAuthPush, ConnectorAuthState, SessionPush } from '@shared/models'
import type { ConnectorCheckResult } from '@shared/connectors'
import { DEFAULT_APP_PREFS, MIN_PI_VERSION } from '@shared/models'
import type { PiEvent, RpcCommand, RpcResponse } from '@shared/rpc'
import fixtureRaw from '../features/chat/__fixtures__/real-session-events.jsonl?raw'

const fixtureEvents: PiEvent[] = fixtureRaw
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { type: string })
  .filter((record) => record.type !== 'response') as PiEvent[]

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
      console.error('[pidex mock] replay failed:', error)
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
    defaultState: { status: 'ready' as const },
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
        credentialDir: '/Users/dev/Library/Application Support/pidex/claude-accounts/work',
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
 * session for every folder duplicated each row inside the pidex group — the
 * worktree folder folds into its main repo, so the same `path` was keyed
 * twice and React logged "two children with the same key".
 */
const MOCK_DISK_SESSIONS = [
  {
    path: '/mock/sessions/a.jsonl',
    sessionId: 'a',
    cwd: '/Users/dev/projects/pidex',
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
    entryCount: 96,
    branchCount: 2,
    mtimeMs: Date.now() - 3600_000,
    lastActivityAt: '2026-08-03T09:00:00.000Z',
  },
  {
    path: '/mock/sessions/b.jsonl',
    sessionId: 'b',
    cwd: '/Users/dev/projects/pidex',
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
    cwd: '/Users/dev/projects/pidex/.pidex/worktrees/fix-auth',
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
    entryCount: 9,
    branchCount: 0,
    mtimeMs: Date.now() - 86_400_000 * 9,
    lastActivityAt: '2026-07-20T10:00:00.000Z',
  },
]

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
    (name) => [`/Users/dev/projects/pidex/${name.replace(/\/$/, '')}`, name.endsWith('/')] as const,
  ),
)

function mockDir(dir: string): Array<Record<string, unknown>> {
  return [...mockFs]
    .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === dir)
    .map(([path, isDirectory]) => ({
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      isDirectory,
      relativePath: path.replace('/Users/dev/projects/pidex/', ''),
    }))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
}

function mockTree(): Record<string, unknown> {
  return {
    sessionId: 'a',
    cwd: '/Users/dev/projects/pidex',
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
  counts: { tools: 6, mcpTools: 12, messages: 9 },
  approximate: true,
})

export function installMockPidex(): void {
  const api: PidexApi = {
    // The browser harness has no Electron; report the real host so key hints
    // in `npm run dev:web` match the machine the developer is sitting at.
    platform: navigator.userAgent.includes('Mac')
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux',

    invoke: (channel: string, ...args: unknown[]) => {
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
              { path: '/Users/dev/projects/pidex', name: 'pidex', lastOpenedAt: Date.now() },
              {
                path: '/Users/dev/projects/other',
                name: 'other',
                lastOpenedAt: Date.now() - 8.64e7,
              },
            ],
            pinnedSessions: [],
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
          })
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
          return Promise.resolve('/Users/dev/projects/pidex')
        case 'app:createSandbox':
          return Promise.resolve('/Users/dev/sandboxes/sandbox-1')
        case 'app:listSandboxes':
          return Promise.resolve([
            {
              path: '/Users/dev/sandboxes/sandbox-1',
              name: 'sandbox-1',
              itemCount: 0,
              lastUsedAt: Date.now() - 3_600_000,
            },
          ])
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
                id: 'mock-ctx',
                method: 'setStatus',
                statusKey: 'pidex-context-breakdown',
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
          }, 120)
          return Promise.resolve({
            sessionId: 'mock-session-id',
            workspacePath: '/Users/dev/projects/pidex',
            pid: 1234,
          })
        case 'pi:command': {
          const command = args[1] as RpcCommand
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
            'electron/pi/rpc-client.ts',
            'package.json',
            'README.md',
          ])
        case 'pi:agentSettings':
          return Promise.resolve({
            defaultProvider: 'anthropic',
            defaultModel: 'claude-opus-5',
            defaultThinkingLevel: 'medium',
            packages: ['npm:pi-web-access', 'npm:pi-mcp-adapter'],
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
                description: 'Diagnose a failing pidex session outside-in.',
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
              spec: 'npm:pi-mcp-adapter',
              scope: 'global',
              kind: 'npm',
              filtered: false,
              name: 'pi-mcp-adapter',
              version: '1.1.0',
              description: 'MCP adapter extension for the pi coding agent',
              installed: false,
              resources: { extensions: [], skills: [], prompts: [], themes: [] },
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
            'npm:pi-mcp-adapter': '1.4.0',
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
          return Promise.resolve(undefined as never)
        case 'claude:cancelLogin':
          clearTimeout(mockClaudeLoginTimer)
          emitClaudeLoginState({ phase: 'cancelled' } as never)
          return Promise.resolve(undefined as never)
        case 'claude:logout':
          mockClaudeAuth = { loggedIn: false }
          return Promise.resolve(undefined as never)
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
            runMockJob(['$ pi -p --model pi-claude-cli/claude-haiku-4-5 …', 'pidex-provider-ok']),
          )
        case 'mcp:readConfigs':
          return Promise.resolve({
            servers: [
              {
                name: 'linear',
                config: {
                  url: 'https://mcp.linear.app/sse',
                  directTools: ['get_issue', 'save_issue'],
                },
                scope: 'pi-global',
                shadows: [],
              },
              {
                name: 'snowflake',
                config: { command: 'npx', args: ['snowflake-mcp'], disabled: true },
                scope: 'pi-project',
                shadows: ['pi-global'],
              },
            ],
            files: [
              {
                scope: 'xdg',
                path: '/Users/dev/.config/mcp/mcp.json',
                exists: false,
                malformed: false,
                serverNames: [],
              },
              {
                scope: 'agents',
                path: '/Users/dev/.agents/mcp.json',
                exists: false,
                malformed: false,
                serverNames: [],
              },
              {
                scope: 'agents-dir',
                path: '/Users/dev/.agents/mcp/mcp.json',
                exists: false,
                malformed: false,
                serverNames: [],
              },
              {
                scope: 'pi-global',
                path: '/Users/dev/.pi/agent/mcp.json',
                exists: true,
                malformed: false,
                serverNames: ['linear', 'snowflake'],
              },
              {
                scope: 'project',
                path: '/Users/dev/projects/pidex/.mcp.json',
                exists: false,
                malformed: false,
                serverNames: [],
              },
              {
                scope: 'pi-project',
                path: '/Users/dev/projects/pidex/.pi/mcp.json',
                exists: true,
                malformed: false,
                serverNames: ['snowflake'],
              },
            ],
          })
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

        case 'mcp:submitAuthCallback':
          return true

        case 'mcp:cancelAuth':
          return undefined

        case 'mcp:checkServer': {
          const serverName = String(args[0])
          const result: ConnectorCheckResult =
            serverName === 'notion'
              ? { serverName, outcome: 'failed', detail: 'fetch failed (ENOTFOUND)' }
              : { serverName, outcome: 'connected', toolCount: 42, resourceCount: 0 }
          // Slow enough that the harness shows the pending state.
          return new Promise<ConnectorCheckResult>((resolve) =>
            setTimeout(() => resolve(result), 900),
          )
        }

        case 'mcp:readCache':
          return Promise.resolve([
            { name: 'linear', tools: ['get_issue', 'save_issue', 'list_issues'] },
          ])
        case 'mcp:upsertServer':
        case 'mcp:removeServer':
        case 'mcp:setDisabled':
        case 'mcp:writeFile':
          return Promise.resolve(undefined)
        case 'mcp:readFile':
          return Promise.resolve({
            path: '/Users/dev/.pi/agent/mcp.json',
            content: '{\n  "mcpServers": {}\n}\n',
          })
        case 'pi:catalogueModels':
          return Promise.resolve([
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
          ])
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
        case 'sessions:list': {
          const workspacePath = args[0] as string
          return Promise.resolve(MOCK_DISK_SESSIONS.filter((m) => m.cwd === workspacePath))
        }
        case 'sessions:stats':
          return Promise.resolve(mockStats())
        case 'app:openExternal':
          return Promise.resolve(undefined)
        case 'clipboard:readFiles':
          return Promise.resolve(mockFileClipboard)
        case 'clipboard:writeFiles':
          mockFileClipboard = { paths: args[0] as string[], cut: args[1] as boolean }
          return Promise.resolve(undefined)
        case 'clipboard:writeImage':
          return mockClipboardWriteImage(args[0] as { data: string; mimeType: string })
        case 'gh:available':
          return Promise.resolve(true)
        case 'gh:prForBranch':
          return Promise.resolve({
            number: 42,
            title: 'Composer attachments and worktree controls',
            state: 'OPEN',
            url: 'https://github.com/agustinsacco/pidex/pull/42',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            checks: { passed: 3, failed: 0, pending: 1, total: 4 },
          })
        case 'artifacts:stageHtml':
          // The browser harness has no custom protocol; a blob URL previews
          // the same content. It inherits the page CSP, so scripts stay
          // blocked here — only the packaged app runs artifact JS.
          return Promise.resolve(
            URL.createObjectURL(new Blob([args[0] as string], { type: 'text/html' })),
          )
        case 'app:setLanePrefs':
          return Promise.resolve(undefined)
        case 'app:setLaneMarkers':
          return Promise.resolve(undefined)
        case 'gh:prsForRepo':
          // Branch keys must match the mock git:infoBatch branches below, or
          // the harness renders a sidebar with no PR chips at all.
          return Promise.resolve({
            'fix/phase0-chat-ux': {
              number: 42,
              title: 'Composer attachments and worktree controls',
              state: 'OPEN',
              url: 'https://github.com/agustinsacco/pidex/pull/42',
              checks: { passed: 3, failed: 0, pending: 1, total: 4 },
              reviewDecision: 'APPROVED',
            },
            main: {
              number: 39,
              title: 'Lane loop removal',
              state: 'MERGED',
              url: 'https://github.com/agustinsacco/pidex/pull/39',
              checks: { passed: 4, failed: 0, pending: 0, total: 4 },
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
                      mainRepoPath: '/Users/dev/projects/pidex',
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
              path: '/Users/dev/projects/pidex',
              realPath: '/Users/dev/projects/pidex',
              branch: 'main',
              head: 'abcdef1234567890',
              isMain: true,
              locked: false,
              prunable: false,
              dirtyCount: 3,
            },
            {
              path: '/Users/dev/projects/pidex/.pidex/worktrees/fix-auth',
              realPath: '/Users/dev/projects/pidex/.pidex/worktrees/fix-auth',
              branch: 'fix-auth',
              head: '123456abcdef7890',
              isMain: false,
              locked: false,
              prunable: false,
              dirtyCount: 0,
            },
            {
              // Outside `.pidex/worktrees`, so nothing about the path says
              // "worktree". It must still fold into the pidex group on the
              // first render, from the root this call was made against.
              path: '/tmp/pidex-pr-4821',
              realPath: '/tmp/pidex-pr-4821',
              branch: 'pr-4821',
              head: '9876fedcba543210',
              isMain: false,
              locked: false,
              prunable: false,
              dirtyCount: 1,
            },
            {
              // Folder deleted behind git's back. Never a sidebar group.
              path: '/Users/dev/projects/pidex-gone',
              realPath: '/Users/dev/projects/pidex-gone',
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
                worktreePath: '/Users/dev/projects/pidex/.pidex/worktrees/fix-auth',
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
            path: `/Users/dev/projects/pidex/.pidex/worktrees/${args[1] as string}`,
            realPath: `/Users/dev/projects/pidex/.pidex/worktrees/${args[1] as string}`,
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
        case 'sessions:readTree':
          return Promise.resolve(mockTree())
        // No provider sidecar in the browser harness, so the debug block
        // falls back to the pi session id — the same shape a real
        // pre-observer-mode session produces.
        case 'sessions:claudeSessionId':
          return Promise.resolve(null)
        case 'fs:readDir': {
          const dir = args[1] as string
          return Promise.resolve(mockDir(dir))
        }
        case 'fs:readFile': {
          const path = args[0] as string
          return Promise.resolve({
            path,
            content: `// ${path}\nexport function hello(): string {\n  return 'from mock'\n}\n`,
            size: 64,
            mtimeMs: Date.now(),
          })
        }
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
              packages: ['npm:pi-web-access', 'npm:pi-mcp-adapter'],
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
    piCommand: (sessionId, command) =>
      (api.invoke as (c: string, ...a: unknown[]) => Promise<never>)(
        'pi:command',
        sessionId,
        command,
      ),
  } as PidexApi

  window.pidex = api
  console.info('[pidex] mock preload API installed (browser dev mode)')
}
