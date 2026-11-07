import { test, expect } from './fixture'

/* Lanes is a device section: the browser shows it and keeps its prefs, which name its Host lanes' branches. */
test('the browser keeps its Lanes preferences across a reload', async ({ page, stack }) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  const open = async () => {
    await page.goto(`${stack.origin}/pages/settings/${stack.hostId}`)
    const settings = page.getByTestId('settings-surface')
    await settings
      .getByRole('navigation', { name: 'Settings sections', exact: true })
      .getByRole('button', { name: 'Lanes', exact: true })
      .click()
    return settings
  }
  let settings = await open()
  // Host lanes always get their own branch, so the browser has no switch for it.
  await expect(settings.getByText('Give each chat its own branch', { exact: true })).toHaveCount(0)
  const prefix = settings.getByRole('textbox', { name: 'Branch prefix', exact: true })
  await prefix.fill('ada/')
  await prefix.press('Enter')
  await settings.getByRole('radio', { name: 'Off', exact: true }).click()
  await settings.getByRole('switch', { name: 'PR status on lanes', exact: true }).click()
  settings = await open()
  await expect(settings.getByRole('textbox', { name: 'Branch prefix', exact: true })).toHaveValue(
    'ada/',
  )
  await expect(settings.getByRole('radio', { name: 'Off', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(
    settings.getByRole('switch', { name: 'PR status on lanes', exact: true }),
  ).toHaveAttribute('aria-checked', 'false')
})
