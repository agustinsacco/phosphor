const HOME_PROMPT = 'Describe a task or ask a question'
/** A real turn can be minutes; the ceiling is generous, not a target. */
const TURN_TIMEOUT = 600_000
const settle = async (page, ms = 2400) => page.waitForTimeout(ms)

/** A turn is over when the composer's Stop control has come and gone. */
async function runTurn(page) {
  // exact: a sidebar PR badge's accessible name can contain the word "stop".
  const stop = page.getByLabel('Stop', { exact: true }).first()
  await stop.waitFor({ timeout: 90_000 })
  await stop.waitFor({ state: 'hidden', timeout: TURN_TIMEOUT })
  // Post-turn dust: auto-naming, changes scan, artifact replay.
  await settle(page, 4000)
}

/** Pick a model in the HOME composer's menu: provider chip, then search. */
async function pickHomeModel(page, provider, query) {
  await page.getByTestId('home-model-picker').click()
  await page.getByTestId('model-list').waitFor({ timeout: 20_000 })
  // The menu's provider filter chips (aria-pressed toggles, "name count").
  // A bare name match also hits the home picker itself, whose label names
  // the provider serving its current model.
  const chip = new RegExp(`^${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\d*$`)
  await page.locator('button[aria-pressed]').filter({ hasText: chip }).first().click()
  await page.getByTestId('model-search').fill(query)
  await settle(page, 800)
  await page.getByTestId('model-row').first().click()
}

async function reachWorkspaceHome({ page, homeComposer }) {
  // ---- Reach the workspace home.
  const picker = page.getByRole('button', { name: /Open Folder/i })
  await picker.or(homeComposer).first().waitFor({ timeout: 60_000 })
  if (await picker.isVisible()) await picker.click()
  await homeComposer.waitFor({ timeout: 30_000 })
  await page.getByTestId('workspace-chip').waitFor({ timeout: 15_000 })

  // Fresh prefs follow the OS appearance; the gallery is shot dark with one
  // light closer, so pin the theme rather than inherit the developer's OS.
  await page.keyboard.press('ControlOrMeta+Comma')
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await page.keyboard.press('Escape')
  await settle(page, 1500)
}

async function runEditSession({ page, homeComposer }, PROVIDER_EDIT, MODEL_EDIT, TASK_EDIT) {
  // ---- 1. The edit session, in a worktree ("new branch" stays ticked) so
  // the edit lands on a disposable branch, never the checkout the developer
  // is standing on.
  await page.getByRole('checkbox', { name: 'new branch' }).check()
  await pickHomeModel(page, PROVIDER_EDIT, MODEL_EDIT)
  await homeComposer.fill(TASK_EDIT)
  await page.getByRole('button', { name: /Start lane/i }).click()
  console.log('edit session: running…')
  await runTurn(page)
}

async function captureEditPanes({ page, shot }) {
  // ---- 2. Chat: the last activity run expanded on its edit's diff.
  const summary = page.getByTestId('activity-summary').last()
  await summary.waitFor({ timeout: 30_000 })
  if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click()
  const editCard = page.getByRole('button', { name: /Edited\s/ }).last()
  if (await editCard.isVisible().catch(() => false)) await editCard.click()
  await settle(page, 3500)
  await shot('chat')

  // ---- 3. Changes: the session's touched files with per-file diff.
  await page.getByTitle(/Changes pane/).click()
  await page.getByText('Files changed').waitFor({ timeout: 15_000 })
  await settle(page, 3500)
  await shot('changes')

  // ---- 4–6. Files pane: right, left, fullscreen — a real tree, a real file.
  await page.getByTitle(/Files pane/).click()
  await settle(page, 3500)
  await page.getByTestId('right-pane').getByRole('button', { name: 'README.md' }).first().click()
  await settle(page, 3000)
  await shot('files')

  await page.getByTitle('Move pane to the left').click()
  await settle(page, 3500)
  await shot('files-left')
  await page.getByTitle('Move pane to the right').click()
  await settle(page, 2500)

  await page.getByTitle('Fullscreen pane').click()
  await settle(page, 3000)
  await shot('files-full')
  await page.getByTitle('Exit fullscreen').click()
  await settle(page, 2500)

  // ---- 7. Terminal: a real shell in the workspace, running a real command.
  await page.getByTitle(/Terminal pane/).click()
  await settle(page, 3500)
  await page.getByTestId('right-pane').click()
  await page.keyboard.type('git log --oneline -6')
  await page.keyboard.press('Enter')
  await settle(page, 2500)
  await shot('terminal')
}

async function runArtifactSession(
  { page, homeComposer, shot },
  PROVIDER_ARTIFACT,
  MODEL_ARTIFACT,
  TASK_ARTIFACT,
) {
  // ---- 8. The artifact session, on the subscription-backed provider (its
  // custom pi tools arrive via the MCP handoff — worth showing for real).
  await page.getByRole('button', { name: /^New$/ }).click()
  await homeComposer.waitFor({ timeout: 20_000 })
  await page.getByRole('checkbox', { name: 'new branch' }).uncheck()
  await pickHomeModel(page, PROVIDER_ARTIFACT, MODEL_ARTIFACT)
  await homeComposer.fill(TASK_ARTIFACT)
  await page.getByRole('button', { name: /Start lane/i }).click()
  console.log('artifact session: running…')
  await runTurn(page)

  // The pane opens itself on the project's first artifact only; on a real
  // workspace that ship has sailed, so open it explicitly.
  const artifactScroll = page.getByTestId('artifact-scroll')
  if (!(await artifactScroll.isVisible().catch(() => false))) {
    await page.getByTitle('Artifacts pane').click()
  }
  await artifactScroll.waitFor({ timeout: 30_000 })
  await artifactScroll.evaluate((el) => (el.scrollTop = 260))
  await settle(page, 2500)
  await shot('artifacts')
  await page.getByTitle('Close pane').click()
  await settle(page, 2000)
}

async function captureComposer({ page, shot }) {
  // ---- 9. The composer's bells and whistles, on the artifact session.
  // The model chooser: the full multi-provider catalogue, with the chip
  // naming what actually serves this session.
  const composer = page.getByPlaceholder(/Describe a task…/)
  await page.getByTestId('model-chip').click()
  await page.getByTestId('model-list').waitFor({ timeout: 20_000 })
  await settle(page, 1500)
  await shot('models')
  await page.keyboard.press('Escape')
  await settle(page, 800)

  // The thinking ladder (only rendered when the model has levels to pick).
  const thinkingChip = page.getByTestId('thinking-chip')
  if (await thinkingChip.isVisible().catch(() => false)) {
    await thinkingChip.click()
    await settle(page, 1200)
    await shot('thinking')
    await page.keyboard.press('Escape')
    await settle(page, 800)
  }

  // The context meter popover: live composition of the window, real tokens.
  await page.getByTitle(/^Context: /).click()
  await settle(page, 1800)
  await shot('context')
  await page.keyboard.press('Escape')
  await settle(page, 800)

  // The slash-command menu…
  await composer.click()
  await page.keyboard.type('/')
  await settle(page, 1200)
  await shot('commands')
  await composer.fill('')

  // …and @ file mentions, resolved against the real workspace tree.
  await page.keyboard.type('@')
  await settle(page, 1500)
  await shot('mentions')
  await composer.fill('')
  await page.keyboard.press('Escape')
}

async function captureHomeSettings({ page, homeComposer, shot }) {
  // ---- 10. Home: the composer over the real sessions of a real repo.
  await page.getByRole('button', { name: /^New$/ }).click()
  await homeComposer.waitFor({ timeout: 20_000 })
  await settle(page, 2200)
  await shot('home')

  // ---- 11–13. Settings: Appearance, the signed-in providers, connectors.
  await page.keyboard.press('ControlOrMeta+Comma')
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settle(page)
  await shot('settings')
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await settle(page)
  await shot('accounts')
  await page.getByRole('button', { name: 'MCP Connectors', exact: true }).click()
  await settle(page)
  await shot('connectors')

  // ---- 14. The light theme, on the edit session.
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await page.keyboard.press('Escape')
  // Newest first: the artifact session was started last, so the edit
  // session (the one with a diff worth showing) is the second row.
  await page.getByTestId('session-row').nth(1).click()
  await page.getByPlaceholder(/Describe a task…/).waitFor({ timeout: 20_000 })
  await settle(page, 3500)
  await shot('light')
}

export async function runLiveScenarios({ page, shot }, config) {
  const state = { page, shot, homeComposer: page.getByPlaceholder(HOME_PROMPT) }
  await reachWorkspaceHome(state)
  await runEditSession(state, config.PROVIDER_EDIT, config.MODEL_EDIT, config.TASK_EDIT)
  await captureEditPanes(state)
  await runArtifactSession(
    state,
    config.PROVIDER_ARTIFACT,
    config.MODEL_ARTIFACT,
    config.TASK_ARTIFACT,
  )
  await captureComposer(state)
  await captureHomeSettings(state)
}
