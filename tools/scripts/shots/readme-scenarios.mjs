import { captureShot, settle } from './readme-capture.mjs'

const HOME_PROMPT = 'Describe a task or ask a question'

/** The prompt the stub answers with an edit + an artifact. */
const TASK = 'Update hello.ts'

export async function startSession(state) {
  const { page } = state
  // ---- Reach the workspace home (the app may restore a session instead).
  const picker = page.getByRole('button', { name: /Open Folder/i })
  const homeComposer = page.getByPlaceholder(HOME_PROMPT)
  state.homeComposer = homeComposer
  await picker.or(homeComposer).first().waitFor({ timeout: 60_000 })
  if (await picker.isVisible()) await picker.click()
  await homeComposer.waitFor({ timeout: 30_000 })

  // The project's own name, not the mkdtemp slug.
  await page.getByTestId('workspace-chip').waitFor({ timeout: 15_000 })

  // ---- 1. One real session, from the home composer, on the checked-out
  // branch (unticked so no worktree chrome lands in the shots).
  await page.getByRole('checkbox', { name: 'new branch' }).uncheck()
  await homeComposer.fill(TASK)
  await page.getByRole('button', { name: /Start lane/i }).click()
  await page.getByText(/Done:\s*hello\.ts\s*updated\./).waitFor({ timeout: 60_000 })

  // Auto-naming hands the stub's fixed title back, which reads like a bug in
  // a screenshot. Renaming through the row's inline editor is the ordinary
  // user path (and really persists to the session file), so the sidebar and
  // title bar carry a sane name.
  const row = page.getByTestId('session-row').first()
  await row.waitFor({ timeout: 30_000 })
  await row.dblclick()
  const rename = page.getByLabel('Session name')
  await rename.waitFor({ timeout: 10_000 })
  await rename.fill('Update hello world greeting')
  await page.keyboard.press('Enter')
  await row.click()
}

export async function captureChatAndChanges(state) {
  const { page } = state
  // ---- 2. Chat: the settled activity run expanded, with the edit card open
  // on its diff. The group collapses once the turn lands, so expand it.
  const summary = page.getByTestId('activity-summary').first()
  await summary.waitFor({ timeout: 30_000 })
  if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click()
  const editCard = page.getByRole('button', { name: /Edited\s+hello\.ts/ })
  await editCard.waitFor({ timeout: 20_000 })
  await editCard.click()
  // The artifacts pane opens itself on a project's first artifact; close it so
  // this shot is the conversation, and let the panel cross-fade settle (it is
  // a real transition — capturing early ghosts two panels into one frame).
  await page.getByTitle('Artifacts pane').click()
  await settle(page, 3500)
  await captureShot(state, 'chat')

  // ---- 3. The Changes pane: the session's touched files with per-file diff.
  await page.getByTitle(/Changes pane/).click()
  await page.getByText('Files changed').waitFor({ timeout: 15_000 })
  await page.getByText('hello.ts').first().waitFor({ timeout: 15_000 })
  await settle(page, 3500)
  await captureShot(state, 'changes')
}

export async function captureFiles(state) {
  const { page } = state
  // ---- 4. Files pane on its default side (right): explorer + Monaco on the
  // file the session touched.
  await page.getByTitle(/Files pane/).click()
  await settle(page, 3500)
  // Scoped to the pane: the transcript's edit card also reads "hello.ts".
  await page.getByTestId('right-pane').getByRole('button', { name: 'hello.ts' }).click()
  await settle(page, 3000)
  await captureShot(state, 'files')

  // ---- 5. The same pane docked LEFT of the chat — every pane carries a
  // side-swap control, and the orientation persists per session.
  await page.getByTitle('Move pane to the left').click()
  await settle(page, 3500)
  await captureShot(state, 'files-left')
  await page.getByTitle('Move pane to the right').click()
  await settle(page, 2500)

  // ---- 6. The pane fullscreened over the whole session region.
  await page.getByTitle('Fullscreen pane').click()
  await settle(page, 3000)
  await captureShot(state, 'files-full')
  await page.getByTitle('Exit fullscreen').click()
  await settle(page, 2500)
}

export async function captureTerminalAndHome(state) {
  const { page } = state
  // ---- 7. Terminal switched in beside the chat. Panes are switches, not
  // columns: opening Files then Terminal shows only the last one, so this
  // shot is honestly the terminal, and the README says so.
  await page.getByTitle(/Terminal pane/).click()
  await settle(page, 3500)
  await captureShot(state, 'terminal')

  // ---- 8. Home with a live session: mission control. Every card is a
  // projection of main's view of pi's event stream, answerable in place.
  await page.getByRole('button', { name: /^New$/ }).click()
  // The lane board renders nothing while every lane is idle (the stub turn
  // has settled by now); the ledger below it always shows the session.
  await page.getByTestId('home-ledger').waitFor({ timeout: 20_000 })
  await settle(page, 2200)
  await captureShot(state, 'home')
}

export async function captureArtifacts(state) {
  const { page, homeComposer } = state
  // ---- 9. Artifacts: a second session whose deliverable is a long document,
  // in the pane that opens by itself on a project's first artifact. Scrolled
  // so the viewer shows body text rather than the gallery header.
  await page.getByRole('button', { name: /^New$/ }).click()
  await homeComposer.waitFor({ timeout: 20_000 })
  await page.getByRole('checkbox', { name: 'new branch' }).uncheck()
  // `longartifact` is the phrase the e2e pi stub branches on.
  await homeComposer.fill('write a longartifact please')
  await page.getByRole('button', { name: /Start lane/i }).click()
  const artifactScroll = page.getByTestId('artifact-scroll')
  await artifactScroll.waitFor({ timeout: 60_000 })
  await artifactScroll.evaluate((el) => (el.scrollTop = 260))

  // Rename before the shot: the title bar of a screenshot reading "Stub
  // Session Title" looks like a defect, not a fixture.
  const secondRow = page.getByTestId('session-row').first()
  await secondRow.dblclick()
  const rename2 = page.getByLabel('Session name')
  await rename2.waitFor({ timeout: 10_000 })
  await rename2.fill('Draft the long-form report')
  await page.keyboard.press('Enter')
  await settle(page, 2500)
  await captureShot(state, 'artifacts')
}

export async function captureSubagents(state) {
  const { page, homeComposer } = state
  // ---- 9b. One lane delegating to four sub-agents at once, beside the
  // other lanes in the sidebar. `in parallel` is the stub's trigger; it holds
  // the run mid-flight (one child done, three working) until
  // `/stub-finish-parallel`, so the frame never races the settle.
  await page.getByRole('button', { name: /^New$/ }).click()
  await homeComposer.waitFor({ timeout: 20_000 })
  await page.getByRole('checkbox', { name: 'new branch' }).uncheck()
  await homeComposer.fill('Fix the token refresh bug, split the work in parallel')
  await page.getByRole('button', { name: /Start lane/i }).click()
  const workflow = page.getByRole('button', { name: /Running workflow/ })
  await workflow.waitFor({ timeout: 60_000 })
  const parallelRow = page.getByTestId('session-row').first()
  await parallelRow.dblclick()
  const rename3 = page.getByLabel('Session name')
  await rename3.waitFor({ timeout: 10_000 })
  await rename3.fill('Fix the token refresh bug')
  await page.keyboard.press('Enter')
  await workflow.click()
  await page.getByTestId('subagent-child').nth(3).waitFor({ timeout: 10_000 })
  await settle(page, 3000)
  await captureShot(state, 'subagents')
}

export async function captureSettings(state) {
  const { page } = state
  // ---- 10. Settings → Appearance. It is the tab that carries the theme
  // switch, and picking Light here sets up the last shot.
  await page.keyboard.press('ControlOrMeta+Comma')
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settle(page)
  await captureShot(state, 'settings')
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await page.keyboard.press('Escape')

  // ---- 11. The same conversation in the paper theme, so both are on record.
  // By name: the parallel lane above is now the newest row.
  await page.getByTestId('session-row').filter({ hasText: 'Draft the long-form report' }).click()
  await page.getByPlaceholder(/Describe a task…/).waitFor({ timeout: 20_000 })
  await settle(page, 3500)
  await captureShot(state, 'light')
}
