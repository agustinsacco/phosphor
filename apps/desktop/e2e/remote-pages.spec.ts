import { test, expect } from '@playwright/test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import { selectMachine, openRemote, takeControl, captures, pane } from './fixtures/remote-ui'

test('Browse, add and remove folders on bee1', async ({ browserName: _browserName }, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page
      .getByRole('button', { name: 'Workspace options for repository', exact: true })
      .click()
    await h.page.getByRole('button', { name: 'Add folder on bee1…', exact: true }).click()
    const modal = h.page.locator('[data-modal-overlay]')
    await expect(
      modal.getByRole('navigation', { name: 'Folder breadcrumbs', exact: true }),
    ).toContainText('Home')
    await expect(modal.getByRole('button', { name: /repository.*git.*Added/ })).toBeVisible()
    await captures(h, info, 'remote-folder-browser')
    await expect(modal.getByRole('button', { name: /escape/ })).toHaveCount(0)
    // A new folder opens in place; hidden folders are listed only on request.
    await modal.getByRole('button', { name: 'New folder', exact: true }).click()
    await modal.getByRole('textbox', { name: 'New folder name', exact: true }).fill('.made')
    await modal.getByRole('button', { name: 'Create', exact: true }).click()
    const crumbs = modal.getByRole('navigation', { name: 'Folder breadcrumbs', exact: true })
    await expect(crumbs).toContainText('.made')
    expect((await stat(join(h.root, '.made'))).isDirectory()).toBe(true)
    await crumbs.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(modal.getByRole('button', { name: /addable/ })).toBeVisible()
    await expect(modal.getByRole('button', { name: /\.made/ })).toHaveCount(0)
    await modal.getByRole('checkbox', { name: 'Show hidden', exact: true }).check()
    await expect(modal.getByRole('button', { name: /\.made/ })).toBeVisible()
    await modal.getByRole('button', { name: /addable/, exact: false }).click()
    await modal.getByRole('button', { name: 'Add this folder', exact: true }).click()
    await expect(
      h.page.getByRole('button', { name: 'Workspace options for addable', exact: true }),
    ).toBeVisible()
    await h.page.getByRole('button', { name: 'Workspace options for addable', exact: true }).click()
    await h.page.getByRole('button', { name: 'Remove from bee1', exact: true }).click()
    await expect(modal).toContainText('kept')
    await modal.getByRole('button', { name: 'Remove folder', exact: true }).click()
    await expect(
      h.page.getByRole('button', { name: 'Workspace options for addable', exact: true }),
    ).toHaveCount(0)
    expect(await readFile(join(h.addable, 'addable.txt'), 'utf8')).toBe('HOST_ADDABLE_ONLY\n')
    await h.page
      .getByRole('button', { name: 'Workspace options for repository', exact: true })
      .click()
    await h.page.getByRole('button', { name: 'Remove from bee1', exact: true }).click()
    await modal.getByRole('button', { name: 'Remove folder', exact: true }).click()
    await expect(modal.getByRole('alert')).toContainText('Stop its lanes before retrying.')
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally {
    await h.close()
  }
})

// parity fix: remote artifacts + tool rows
test('Remote artifacts and Skills are useful read-only pages', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('artifact')
    await chat.press('Enter')
    await pane(h, 'Artifacts')
    await expect(h.page.getByText('HOST_A_ONLY card', { exact: true }).first()).toBeVisible()
    await expect(
      h.page.getByRole('button', { name: 'Save source to This Mac…', exact: true }),
    ).toBeVisible()
    await expect(
      h.page
        .getByTestId('right-pane')
        .getByRole('button', { name: 'Not available on remote lanes yet.', exact: true }),
    ).toBeDisabled()
    const preview = h.page.frameLocator('iframe[title="HOST_A_ONLY card"]')
    await expect(
      preview.getByRole('heading', { name: 'HOST_A_ONLY version 1', exact: true }),
    ).toBeVisible()
    await expect(h.page.locator('iframe[title="HOST_A_ONLY card"]')).toHaveAttribute(
      'sandbox',
      'allow-scripts',
    )
    const savedPath = join(h.root, 'download.html')
    await h.app.evaluate(
      ({ dialog, shell, app }, paths) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.source })
        shell.showItemInFolder = () => undefined
        const getPath = app.getPath.bind(app)
        app.getPath = (name) => (name === 'downloads' ? paths.downloads : getPath(name))
      },
      { source: savedPath, downloads: h.root },
    )
    await h.page.getByRole('button', { name: 'Save source to This Mac…', exact: true }).click()
    await expect.poll(() => readFile(savedPath, 'utf8')).toContain('HOST_A_ONLY version 1')
    await h.page
      .getByRole('button', { name: 'Export preview to PDF (This Mac Downloads)', exact: true })
      .click()
    await expect(h.page.getByText(/PDF saved to Downloads/)).toBeVisible()
    await chat.fill('artifact version two')
    await chat.press('Enter')
    await expect(h.page.getByRole('combobox', { name: 'Version', exact: true })).toHaveValue('2')
    await expect(
      preview.getByRole('heading', { name: 'HOST_A_ONLY version 2', exact: true }),
    ).toBeVisible()
    try {
      await h.page.getByRole('combobox', { name: 'Version', exact: true }).selectOption('1')
      await expect(h.page.getByRole('combobox', { name: 'Version', exact: true })).toHaveValue('1')
      await expect(
        preview.getByRole('heading', { name: 'HOST_A_ONLY version 1', exact: true }),
      ).toBeVisible()
      await chat.fill('PHX-pinprobe')
      await chat.press('Enter')
      await expect(h.page.locator('main').getByText('PHX-pinprobe', { exact: true })).toHaveCount(2)
      await expect(h.page.locator('button[aria-label="Stop"]')).toBeHidden()
      await expect(h.page.getByRole('combobox', { name: 'Version', exact: true })).toHaveValue('1')
      await expect(
        preview.getByRole('heading', { name: 'HOST_A_ONLY version 1', exact: true }),
      ).toBeVisible()
    } catch (error) {
      await info.attach('artifact-before-teardown.json', {
        body: JSON.stringify({
          banner: await h.page
            .getByRole('banner')
            .innerText({ timeout: 1000 })
            .catch(() => 'unavailable'),
          version: await h.page
            .getByRole('combobox', { name: 'Version', exact: true })
            .inputValue({ timeout: 1000 })
            .catch(() => 'unavailable'),
          preview: await preview
            .locator('body')
            .innerText({ timeout: 1000 })
            .catch(() => 'unavailable'),
        }),
        contentType: 'application/json',
      })
      throw error
    }
    await captures(h, info, 'remote-artifacts-pane')
    await h.page.getByRole('button', { name: 'Artifacts', exact: true }).first().click()
    await expect(h.page.getByTestId('global-page')).toContainText('HOST_A_ONLY card')
    await expect(h.page.getByTestId('global-page')).not.toContainText('LOCAL_ONLY')
    await h.page.getByRole('button', { name: 'Skills', exact: true }).first().click()
    await expect(h.page.getByTestId('global-page')).toContainText('HOST_A_ONLY')
    await expect(h.page.getByTestId('global-page')).not.toContainText('LOCAL_ONLY')
    await h.page.getByText('host-only', { exact: true }).first().click()
    await expect(h.page.getByTestId('global-page')).toContainText('HOST_A_ONLY skill')
    await expect(h.page.getByRole('button', { name: /^Edit SKILL/ })).toHaveCount(0)
  } finally {
    await h.close()
  }
})

test('Remote routine creation uses Host models and reports history', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'Routines', exact: true }).first().click()
    await h.page.getByRole('button', { name: 'New routine', exact: true }).click()
    const editor = h.page.getByRole('dialog', { name: 'New routine', exact: true })
    await editor.getByLabel('Name', { exact: false }).fill('HOST_A_ONLY UI routine')
    await editor.getByLabel('What should happen?').fill('PHX-routineui')
    await editor
      .getByRole('combobox', { name: 'Routine machine', exact: true })
      .selectOption({ label: 'bee1' })
    await editor
      .getByRole('combobox', { name: 'Routine repository', exact: true })
      .selectOption({ label: 'repository' })
    await editor.getByTestId('routine-model-picker').click()
    await h.page.getByTestId('model-search').fill('HOST_A_ONLY')
    await expect(h.page.getByTestId('model-row').filter({ hasText: 'LOCAL_ONLY' })).toHaveCount(0)
    await h.page.getByTestId('model-row').filter({ hasText: 'HOST_A_ONLY' }).click()
    await editor
      .getByRole('combobox', { name: 'Routine machine', exact: true })
      .selectOption({ label: 'This computer' })
    await expect(editor.getByTestId('routine-model-picker')).not.toContainText('HOST_A_ONLY')
    await editor
      .getByRole('combobox', { name: 'Routine machine', exact: true })
      .selectOption({ label: 'bee1' })
    await expect(editor.getByTestId('routine-model-picker')).not.toContainText('HOST_A_ONLY')
    await editor
      .getByRole('combobox', { name: 'Routine repository', exact: true })
      .selectOption({ label: 'repository' })
    await editor.getByTestId('routine-model-picker').click()
    await h.page.getByTestId('model-search').fill('HOST_A_ONLY')
    await expect(h.page.getByTestId('model-row').filter({ hasText: 'LOCAL_ONLY' })).toHaveCount(0)
    await h.page.getByTestId('model-row').filter({ hasText: 'HOST_A_ONLY' }).click()
    await expect(editor.getByRole('checkbox')).toBeDisabled()
    await editor.getByRole('button', { name: 'Save paused', exact: true }).click()
    await h.page.getByTestId('routine-row').filter({ hasText: 'HOST_A_ONLY UI routine' }).click()
    await h.page.getByRole('button', { name: 'Edit', exact: true }).click()
    const saved = h.page.getByRole('dialog', { name: 'Edit routine', exact: true })
    await saved.getByRole('checkbox').check()
    await saved.getByRole('button', { name: 'Enable on bee1', exact: true }).click()
    await h.page.getByRole('button', { name: 'Run now', exact: true }).click()
    await expect(h.page.locator('main li').filter({ hasText: 'Finished' })).toHaveCount(1)
    await expect(
      h.page.getByText('Output not available from this machine yet', { exact: false }),
    ).toBeVisible()
    await expect(
      h.page
        .locator('main li')
        .filter({ hasText: 'Finished' })
        .getByRole('button', { name: 'Open', exact: true }),
    ).toHaveCount(0)
    await h.page.getByRole('button', { name: 'Edit', exact: true }).click()
    await saved.getByLabel('What should happen?').fill(h.slowTurn.prompt)
    await saved.getByRole('checkbox').check()
    await saved.getByRole('button', { name: 'Enable on bee1', exact: true }).click()
    await h.page.getByRole('button', { name: 'Run now', exact: true }).click()
    const cancel = h.page.getByRole('button', { name: 'Cancel run', exact: true })
    await expect(cancel).toBeVisible()
    await cancel.focus()
    await expect(cancel).toBeFocused()
    await cancel.press('Enter')
    await expect(h.page.locator('main li').filter({ hasText: 'Cancelled' })).toHaveCount(1)
  } finally {
    await h.close()
  }
})

test('Folder policy disabled refuses browsing without changing configuration', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture({ allowRepositoryChanges: false })
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page
      .getByRole('button', { name: 'Workspace options for repository', exact: true })
      .click()
    await h.page.getByRole('button', { name: 'Add folder on bee1…', exact: true }).click()
    const modal = h.page.locator('[data-modal-overlay]')
    await expect(modal.getByRole('alert')).toContainText('Not available on remote lanes yet.')
    await expect(modal.getByRole('button', { name: 'Add this folder', exact: true })).toBeDisabled()
    expect(
      JSON.parse(await readFile(join(h.root, 'conf/config.json'), 'utf8')).repositories,
    ).toHaveLength(2)
  } finally {
    await h.close()
  }
})

// parity fix: machine files entry
test('Host home opens read-only machine Files without a lane', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await pane(h, 'Files')
    await expect(h.page.getByRole('region', { name: 'Machine files', exact: true })).toContainText(
      'Read only',
    )
    await h.page
      .getByRole('combobox', { name: 'Repository', exact: true })
      .selectOption({ label: 'repository' })
    await h.page.getByRole('treeitem', { name: /^remote\.txt/ }).click()
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY')
    await captures(h, info, 'remote-machine-files')
  } finally {
    await h.close()
  }
})

test('The last Host folder can be removed and its files stay', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.backgroundTurn('PHX-persist-before-stop')
    await h.command({ type: 'lane.stop' }, h.laneId)
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'Workspace options for notes', exact: true }).click()
    await h.page.getByRole('button', { name: 'Remove from bee1', exact: true }).click()
    const modal = h.page.locator('[data-modal-overlay]')
    await modal.getByRole('button', { name: 'Remove folder', exact: true }).click()
    await expect(
      h.page.getByRole('button', { name: 'Workspace options for notes', exact: true }),
    ).toHaveCount(0)
    await h.page
      .getByRole('button', { name: 'Workspace options for repository', exact: true })
      .click()
    await h.page.getByRole('button', { name: 'Remove from bee1', exact: true }).click()
    await modal.getByRole('button', { name: 'Remove folder', exact: true }).click()
    await expect(
      h.page.getByRole('button', { name: 'Workspace options for repository', exact: true }),
    ).toHaveCount(0)
    await expect(h.page.getByRole('alert')).toHaveCount(0)
    expect(
      JSON.parse(await readFile(join(h.root, 'conf/config.json'), 'utf8')).repositories,
    ).toEqual([])
    expect(await h.readHostFile('remote.txt')).toContain('HOST_A_ONLY')
  } finally {
    await h.close()
  }
})

test('Host Skills exposes its SKILL.md and catalogue without mutation controls', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'Skills', exact: true }).first().click()
    await expect(h.page.getByTestId('global-page')).toContainText('HOST_A_ONLY fixture')
    await expect(h.page.getByTestId('global-page')).not.toContainText('LOCAL_ONLY')
    await h.page.getByText('Models and providers on this machine', { exact: true }).click()
    await expect(h.page.getByTestId('global-page')).toContainText('HOST_B_ONLY Reasoner')
    await expect(h.page.getByTestId('global-page')).not.toContainText('Stub Model')
    await h.page.getByText('host-only', { exact: true }).first().click()
    await expect(h.page.getByTestId('global-page')).toContainText('HOST_A_ONLY skill')
    await expect(h.page.getByRole('button', { name: /^Edit SKILL/ })).toHaveCount(0)
    await expect(h.page.getByRole('button', { name: /^Delete skill/ })).toHaveCount(0)
  } finally {
    await h.close()
  }
})

test('Sidebar Host selection opens Routines without This Mac activity', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await expect
      .poll(() =>
        h.page.evaluate(async () =>
          (await window.phosphor.invoke('routines:list')).machines?.some(
            (machine) => machine.available,
          ),
        ),
      )
      .toBe(true)
    await h.page.evaluate(async () => {
      const snapshot = await window.phosphor.invoke('routines:list')
      const local = snapshot.routines.find((routine) => routine.name === 'LOCAL_ONLY routine')
      const host = snapshot.machines?.find((machine) => machine.label === 'bee1')
      if (!local || !host) throw new Error('Missing fixture routines')
      const remote = await window.phosphor.invoke('routines:list', host.id)
      for (const routine of remote.routines)
        await window.phosphor.invoke('routines:delete', routine.id)
      await window.phosphor.invoke(
        'routines:save',
        { ...local, trusted: true },
        local.id,
        local.revision,
      )
      await window.phosphor.invoke('routines:run', local.id, crypto.randomUUID())
    })
    await expect
      .poll(() =>
        h.page.evaluate(async () => (await window.phosphor.invoke('routines:list')).runs.length),
      )
      .toBeGreaterThan(0)
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'Routines', exact: true }).first().click()
    const page = h.page.getByTestId('global-page')
    await expect(page).toContainText('Save a task. Give it a schedule.')
    await expect(page).not.toContainText('LOCAL_ONLY')
    await expect(page).not.toContainText('Activity')
    await expect(page).toContainText('Desktop can be closed.')
    await expect(page.locator('input[type=checkbox]')).toHaveCount(0)
    await captures(h, info, 'host-empty-routines')
  } finally {
    await h.close()
  }
})
