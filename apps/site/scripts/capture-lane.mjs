/* global window */
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { source, shot } from './capture-harness.mjs'

const messages = JSON.parse(
  await readFile(new URL('./fixtures/lane-demo.json', import.meta.url), 'utf8'),
)

const file = JSON.parse(
  await readFile(new URL('./fixtures/auth-demo.json', import.meta.url), 'utf8'),
)

export async function prepareLane(page) {
  await page.getByTestId('session-row').filter({ hasText: 'Refactor auth module' }).click()
  await page.getByRole('textbox', { name: 'Chat message' }).waitFor()
  await page.waitForTimeout(1500)
  await page.evaluate(
    async ({ source, messages, file }) => {
      const { useSessionsStore: sessions } = await import(`${source}stores/sessions.ts`)
      const { useChatStore: chat } = await import(`${source}stores/chat.ts`)
      const id = sessions.getState().activeSessionId
      sessions.setState({ baselines: { [id]: 'capture-baseline' } })
      const invoke = window.phosphor.invoke.bind(window.phosphor)
      window.phosphor.invoke = async (channel, ...args) => {
        if (channel === 'fs:readFile' && args[0].endsWith('/src/auth.ts'))
          return { path: args[0], content: file.content, size: file.content.length, mtimeMs: 0 }
        if (channel === 'git:showFileAt' && args[2] === 'src/auth.ts') return file.baseline
        return invoke(channel, ...args)
      }
      const catalogue = await window.phosphor.invoke('pi:catalogueModels')
      const model = catalogue.models[0]
      chat.getState().patchMeta(id, { model })
      chat.getState().setModels(id, catalogue.models)
      const { forgetSessionTransition } = await import(
        `${source}features/sessions/sessionTransition.ts`
      )
      forgetSessionTransition(id)
      chat.getState().doneResuming(id)
      chat.getState().setError(id, null)
      const { useExtensionUiStore } = await import(`${source}stores/extensionUi.ts`)
      useExtensionUiStore.getState().handleRequest(id, {
        type: 'extension_ui_request',
        id: 'capture-no-cli-limit',
        method: 'setStatus',
        statusKey: 'claude-rate-limit',
        statusText: '',
      })

      chat.getState().hydrate(id, messages)
      chat.getState().patchMeta(id, { sessionName: 'Refactor token refresh', isStreaming: false })
      const { useLayoutStore } = await import(`${source}stores/layout.ts`)
      useLayoutStore.setState({
        page: null,
        bySession: { [id]: { pane: null, side: 'right', size: 54, expanded: false } },
      })
    },
    { source, messages, file },
  )
}
export async function captureLane(page) {
  await prepareLane(page)
  await shot(page, 'chat')
  await page.getByTestId('lane-pr-status').click()
  await page.getByRole('region', { name: 'Pull request details' }).waitFor()
  await shot(page, 'lane-pr')
  await page.keyboard.press('Escape')
  await page.evaluate(async (source) => {
    const { useSessionsStore } = await import(`${source}stores/sessions.ts`)
    const { useChatStore } = await import(`${source}stores/chat.ts`)
    const id = useSessionsStore.getState().activeSessionId
    useChatStore
      .getState()
      .addUserMessage(
        id,
        'Reference for this fictional task: https://harbor-demo.slack.com/archives/C0123456789/p1793966400000000\nKeep retry behavior consistent with this thread.',
      )
    useChatStore.getState().clearPromptSent(id)
  }, source)
  await page.getByTestId('lane-slack-threads').click()
  await shot(page, 'slack-pill')
  await page.keyboard.press('Escape')
  await page.evaluate(async (source) => {
    const { useNotificationsStore } = await import(`${source}stores/notifications.ts`)
    useNotificationsStore.getState().record({
      kind: 'info',
      sessionId: 'capture-review',
      title: 'Review ready',
      message: 'Token refresh: the fixture diff is ready for your review.',
    })
    useNotificationsStore.getState().record({
      kind: 'warning',
      sessionId: 'capture-tests',
      title: 'Check needs attention',
      message: 'Harbor Ledger: inspect the failing concurrency check before merging.',
    })
    useNotificationsStore.getState().setOpen(true)
  }, source)
  await shot(page, 'notifications')
  await page.evaluate(async (source) => {
    const { useNotificationsStore } = await import(`${source}stores/notifications.ts`)
    useNotificationsStore.getState().setOpen(false)
  }, source)
}
