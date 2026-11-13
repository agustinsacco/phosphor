import type { ElectronApplication } from '@playwright/test'

/**
 * E2E never reaches GitHub. A spec that stubs branch discovery makes the
 * renderer read those PRs by number too, and the real handler would run the
 * machine's own `gh`. Status by number reads as unavailable unless a spec
 * stubs `gh:prSummaries` itself.
 */
export async function quietGithub(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('gh:prSummaries')
    ipcMain.handle('gh:prSummaries', () => null)
  })
}
