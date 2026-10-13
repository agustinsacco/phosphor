// Replay reviewed, public-safe excerpts in the real renderer, never a live lane.
/* global window, document, queueMicrotask */
import { chromium, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import sharp from 'sharp'

const base = process.env.GUIDE_HARNESS_URL || 'http://127.0.0.1:5199'
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw new Error('Local mock renderer required')
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/remote-hosts.json', import.meta.url), 'utf8'),
)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 920 },
    deviceScaleFactor: 2,
  })
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  )
  await page.goto(base)
  await page.waitForFunction(() => window.__chatStore && window.phosphor)
  await page.getByRole('button', { name: /phosphor.*\/Users\/dev\/projects\/phosphor/s }).click()
  await page.evaluate(async (fixture) => {
    const { useSessionsStore: sessions } = await import('/stores/sessions.ts')
    const { useChatStore: chat } = await import('/stores/chat.ts')
    const { useLayoutStore: layout } = await import('/stores/layout.ts')
    const { useExtensionUiStore: ext } = await import('/stores/extensionUi.ts')
    const { openSubagents } = await import('/features/chat/subagentView.ts')
    const invoke = window.phosphor.invoke.bind(window.phosphor)
    window.phosphor.invoke = async (channel, ...args) => {
      if (channel === 'git:info')
        return {
          isRepo: true,
          branch: 'HEAD',
          dirtyCount: 0,
          ahead: 0,
          behind: 0,
          isWorktree: true,
        }
      return invoke(channel, ...args)
    }
    const id = 'recorded-remote-hosts'
    const cwd = '/projects/phosphor'
    const runIds = fixture.tracks.map((_, i) => `1000000${i}-0000-4000-8000-000000000000`)
    chat.getState().ensure(id)
    chat.getState().hydrate(id, [
      {
        role: 'assistant',
        provider: fixture.parentProvider,
        model: fixture.parentModel,
        content: [{ type: 'text', text: fixture.parentExcerpt }],
        timestamp: Date.parse(fixture.recordedAt),
        stopReason: 'stop',
      },
    ])
    chat.getState().setMeta(id, {
      sessionId: id,
      sessionFile: '/recorded/remote-hosts.jsonl',
      sessionName: fixture.title,
      model: {
        id: fixture.parentModel,
        name: fixture.parentName,
        provider: fixture.parentProvider,
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 32000,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      thinkingLevel: 'high',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 1,
      pendingMessageCount: 0,
    })
    chat.getState().setModels(id, [chat.getState().sessions[id].meta.model])
    chat.getState().setCommands(id, [{ name: 'subagents-inspect-rpc', source: 'extension' }])
    sessions.setState({
      activeSessionId: id,
      opening: null,
      live: {
        [id]: { phosphorId: id, workspacePath: cwd, diskPath: '/recorded/remote-hosts.jsonl' },
      },
    })
    layout.setState({
      sidebarVisible: false,
      page: null,
      bySession: { [id]: { pane: null, expanded: false, side: 'right', size: 54 } },
    })
    const snapshot = {
      kind: 'pi-subagents.async-status-snapshot',
      version: 1,
      generatedAt: Date.parse(fixture.recordedAt),
      runs: fixture.tracks.map((track, index) => ({
        id: runIds[index],
        kind: 'subagent',
        label: track.label,
        state: 'running',
        children: [],
      })),
      omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    }
    ext.getState().handleRequest(id, {
      type: 'extension_ui_request',
      id: 'recorded-fleet',
      method: 'setWidget',
      widgetKey: 'subagent-async',
      widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`],
    })
    window.phosphor.piCommand = async (_session, command) => {
      if (command.type === 'get_commands')
        return {
          success: true,
          data: { commands: [{ name: 'subagents-inspect-rpc', source: 'extension' }] },
        }
      if (command.type === 'get_entries')
        return { success: true, data: { entries: [], leafId: null } }
      if (command.type === 'prompt' && command.message.startsWith('/subagents-inspect-rpc ')) {
        const [, requestId, asyncId] = command.message.split(' ')
        const index = runIds.indexOf(asyncId)
        const track = fixture.tracks[index]
        const reply = {
          kind: 'pi-subagents.inspect-reply',
          version: 1,
          requestId,
          asyncId,
          label: track.label,
          task: `${track.task}\n\nWorker model: Sol 6.1 · high effort.`,
          truncated: false,
          messages:
            track.key === fixture.approvalTrack
              ? [{ role: 'user', text: `### Parent guidance\n\n${fixture.approvalExcerpt}` }]
              : [],
        }
        queueMicrotask(() =>
          ext.getState().handleRequest(id, {
            type: 'extension_ui_request',
            id: requestId,
            method: 'setWidget',
            widgetKey: 'subagent-inspect',
            widgetLines: [`PI_SUBAGENT_INSPECT_JSON:${JSON.stringify(reply)}`],
          }),
        )
      }
      return { success: true }
    }
    openSubagents(id, runIds[1])
  }, fixture)
  await expect(page.getByRole('region', { name: 'Subagents', exact: true })).toContainText(
    'Parent guidance',
  )
  await expect(page.getByTestId('background-work-indicator')).toContainText('4 agents working')
  await expect(page.getByText('No models configured', { exact: true })).toHaveCount(0)
  const pane = page.getByRole('region', { name: 'Subagents', exact: true })
  await pane.getByText(/Later messages to the agent/).click()
  await page.evaluate(() => document.fonts.ready)
  // This allowlisted replay contains no user profile or external source records.
  await expect(page.locator('body')).not.toContainText(
    /agustinsacco|augment|@example|Supabase secret|cloudflared|job-[a-f0-9]/i,
  )
  const image = await page.screenshot({ animations: 'disabled' })
  await sharp(image)
    .webp({ quality: 90 })
    .toFile(new URL('../src/assets/shots/remote-hosts.webp', import.meta.url).pathname)
  console.log(
    'Captured curated Remote Hosts replay. No live agents, credentials or session writes.',
  )
} finally {
  await browser.close()
}
