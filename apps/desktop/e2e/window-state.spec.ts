import { expect, test } from '@playwright/test'
import { accountControlFixture } from './fixtures/account-control'

// The fixture relaunches the same scratch userData without involving the real app.
test('reopens the Desktop window at its last size and position', async () => {
  const h = await accountControlFixture()
  try {
    const saved = await h.app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      const area = screen.getPrimaryDisplay().workArea
      const width = 900
      const height = 600
      window.setBounds({
        x: area.x + Math.max(0, area.width - width - 10),
        y: area.y + Math.max(0, area.height - height - 10),
        width,
        height,
      })
      return { requested: { width, height }, actual: window.getNormalBounds() }
    })
    expect(saved.actual).toMatchObject(saved.requested)
    await h.relaunchDesktop()
    const reopened = await h.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getNormalBounds(),
    )
    expect(reopened).toEqual(saved.actual)
  } finally {
    await h.close()
  }
})
