import type { ElectronApplication } from '@playwright/test'

/** Approve destructive shutdown only during test teardown, never during test actions. */
export function configureTestTeardown(app: ElectronApplication): void {
  const close = app.close.bind(app)
  app.close = async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      })
      .catch(() => {})
    await close()
  }
}
