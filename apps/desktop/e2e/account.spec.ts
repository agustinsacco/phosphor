import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { accountControlFixture } from './fixtures/account-control'

test('first-class footer signs in, opens the account popover and signs out without exposing credentials', async () => {
  const h = await accountControlFixture()
  const { page } = h
  const footer = page.getByTestId('account-footer')
  try {
    await expect(footer.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    expect(h.calls).toHaveLength(0)
    const first = await h.startSignIn()
    const authorize = new URL(first)
    expect(authorize.origin + authorize.pathname).toBe(`${h.url}/auth/v1/authorize`)
    expect(authorize.searchParams.get('provider')).toBe('github')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256')
    expect(authorize.searchParams.get('redirect_to')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback\/[\w-]{22}$/,
    )
    expect(await h.returnFromBrowser(first)).toContain('Signed in as @octo')
    await expect(footer.getByRole('button', { name: 'Your account' })).toBeVisible()
    await footer.getByRole('button', { name: 'Your account' }).click()
    const popover = page.locator('[data-popup-menu]')
    await expect(popover).toContainText('Octo Cat')
    await expect(popover).toContainText('@octo')
    await expect(popover).toContainText('octo@example.com')
    await expect(popover).toContainText('0 online')
    await page.keyboard.press('Escape')
    await expect(footer.getByRole('button', { name: 'Your account' })).toBeFocused()
    expect(existsSync(join(h.userData, 'account', 'session.bin'))).toBe(false)
    const seen = JSON.stringify(await page.evaluate(() => window.phosphor.invoke('account:get')))
    for (const secret of h.secrets) expect(seen).not.toContain(secret)
    expect(
      h.calls.find((call) => call.path === '/auth/v1/token?grant_type=pkce')?.headers.apikey,
    ).toBe('e2e-publishable-key')
    await footer.getByRole('button', { name: 'Your account' }).click()
    await popover.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(footer.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect.poll(() => h.state.answered.length).toBe(1)
    expect(
      h.calls.find((call) => call.path === '/auth/v1/logout?scope=local')?.headers.authorization,
    ).toBe(`Bearer ${h.secrets[0]}`)

    const cancelled = await h.startSignIn()
    await footer.getByRole('button', { name: 'Cancel' }).click()
    await expect(footer.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(h.returnFromBrowser(cancelled)).rejects.toThrow()
    const denied = await h.startSignIn()
    expect(
      await h.returnFromBrowser(denied, 'error=access_denied&error_description=Nope'),
    ).toContain('Sign-in cancelled')
    await expect(footer).toContainText('GitHub sign-in did not finish: Nope')

    await h.signIn()
    h.state.logoutDelayMs = 2_000
    await footer.getByRole('button', { name: 'Your account' }).click()
    await popover.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(footer.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await h.close()
    expect(h.state.answered).toEqual([true, true])
  } finally {
    await h.close()
  }
})
