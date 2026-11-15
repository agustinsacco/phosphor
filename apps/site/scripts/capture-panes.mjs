import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { shot, source, settings, closeSettings } from './capture-harness.mjs'

const { content } = JSON.parse(
  await readFile(new URL('./fixtures/auth-demo.json', import.meta.url), 'utf8'),
)

async function pane(page, name, patch = {}) {
  await page.evaluate(
    async ({ source, name, patch }) => {
      const { useSessionsStore } = await import(`${source}stores/sessions.ts`)
      const { useLayoutStore } = await import(`${source}stores/layout.ts`)
      const id = useSessionsStore.getState().activeSessionId
      useLayoutStore.setState({
        bySession: { [id]: { pane: name, side: 'right', size: 58, expanded: false, ...patch } },
      })
    },
    { source, name, patch },
  )
  await page.waitForTimeout(1600)
}
export async function captureChanges(page) {
  await pane(page, 'changes')
  await page
    .getByTestId('right-pane')
    .getByRole('button', { name: 'View diff for src/auth.ts', exact: true })
    .click()
  await shot(page, 'changes')
}
export async function capturePanes(page) {
  await captureChanges(page)
  await pane(page, 'files')
  await page.evaluate(
    async ({ source, content }) => {
      const { useSessionsStore } = await import(`${source}stores/sessions.ts`)
      const { useFilesStore } = await import(`${source}stores/files.ts`)
      const id = useSessionsStore.getState().activeSessionId
      const cwd = useSessionsStore.getState().live[id].workspacePath
      useFilesStore.setState({
        byWorkspace: {
          [cwd]: {
            openFiles: [
              {
                path: cwd + '/src/auth.ts',
                relativePath: 'src/auth.ts',
                language: 'typescript',
                savedContent: content,
                content,
                mtimeMs: 0,
                size: content.length,
                dirty: false,
              },
            ],
            activePath: cwd + '/src/auth.ts',
            gitStatus: { 'src/auth.ts': ' M' },
          },
        },
      })
    },
    { source, content },
  )
  await page.locator('.monaco-editor').first().waitFor()
  await shot(page, 'files')
  await pane(page, 'files', { side: 'left' })
  await shot(page, 'files-left')
  await pane(page, 'files', { expanded: true })
  await shot(page, 'files-full')
  await pane(page, 'files', { side: 'left', size: 62 })
  await shot(page, 'ide-flex')
  await pane(page, 'terminal')
  await shot(page, 'terminal')
  await page.evaluate(async (source) => {
    const { useSessionsStore } = await import(`${source}stores/sessions.ts`)
    const { useArtifactsStore } = await import(`${source}stores/artifacts.ts`)
    const id = useSessionsStore.getState().activeSessionId
    useArtifactsStore.getState().addLocal(id, {
      title: 'Token refresh review',
      type: 'markdown',
      content:
        '# Token refresh review\n\n## Decision\n\nShare one in-flight promise across concurrent callers. Clear it when the request settles.\n\n## Acceptance checklist\n\n- [x] Public API unchanged\n- [x] Concurrent callers share a single request\n- [x] Rejections permit a later retry\n- [ ] Human review before merge\n\n## Why this approach\n\nThe pending request lives beside the token client, not inside each caller. This keeps ownership explicit and avoids a second state manager.\n\n| Scenario | Expected result |\n| --- | --- |\n| Two simultaneous callers | One network request |\n| Provider rejects refresh | Both callers see the error |\n| Next call after failure | Starts a fresh request |\n\n*Fictional demonstration data. No live service was contacted.*',
    })
  }, source)
  await pane(page, 'artifacts')
  await shot(page, 'artifacts')
  await settings(page, 'appearance')
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await closeSettings(page)
  await shot(page, 'light')
  await settings(page, 'appearance')
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await closeSettings(page)
  await pane(page, null)
}
export async function captureComposer(page) {
  await page.getByRole('button', { name: 'Opus 5', exact: true }).click()
  await shot(page, 'models')
  await shot(page, 'models-picker', page.locator('[data-popup-menu]').last())
  await page.keyboard.press('Escape')
  await page.getByTestId('context-meter').click()
  await shot(page, 'context')
  await shot(page, 'context-meter', page.locator('[data-popup-menu]').last())
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Medium', exact: true }).click()
  await shot(page, 'thinking')
  await page.keyboard.press('Escape')
  const composer = page.getByRole('textbox', { name: 'Chat message' })
  await composer.fill('/')
  await shot(page, 'commands')
  await composer.fill('@')
  await shot(page, 'mentions')
  await composer.fill('')
}
