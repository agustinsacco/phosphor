import { test, expect, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown, privateAgentDir } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

const id = '01a0272a-7be5-76ed-b420-36b363924622'
const fileName = `2026-08-22T22-56-30-785Z_${id}.jsonl`

const sessionDir = (agent: string, cwd: string) =>
  join(agent, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)

/** A stopped lane's transcript: its header, its name and one question. */
const transcript = (cwd: string, name: string, ask: string) =>
  [
    { type: 'session', version: 3, id, cwd, timestamp: '2026-08-22T22:56:30Z' },
    {
      type: 'session_info',
      id: 'name0001',
      parentId: null,
      name,
      timestamp: '2026-08-22T22:56:31Z',
    },
    {
      type: 'message',
      id: 'ask00001',
      parentId: 'name0001',
      timestamp: '2026-08-22T22:56:32Z',
      message: { role: 'user', content: ask },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n') + '\n'

async function seedLane() {
  const workspace = await realpath(await scratchDir('phosphor-e2e-move-'))
  const target = join(workspace, 'another-folder')
  const profile = join(workspace, 'profile')
  const agent = privateAgentDir()
  const source = join(sessionDir(agent, workspace), fileName)
  await mkdir(target)
  await mkdir(profile)
  await mkdir(sessionDir(agent, workspace), { recursive: true })
  const original = transcript(
    workspace,
    'Research to keep',
    'Keep the conversation, not this folder’s files.',
  )
  await writeFile(source, original)
  await writeFile(
    join(profile, 'config.json'),
    JSON.stringify({
      lastWorkspacePath: workspace,
      recentWorkspaces: [
        { path: workspace, name: 'Source' },
        { path: target, name: 'Destination' },
      ],
      pinnedSessions: [source],
      laneMarkers: { [source]: '🔬' },
    }),
  )
  return { workspace, target, profile, agent, source, original }
}

test('Move to… copies a stopped no-git lane to another folder without touching the source', async () => {
  const { workspace, target, profile, agent, source, original } = await seedLane()
  const h = await launch({ workspace, agentDir: agent, userDataDir: profile })
  try {
    const row = h.page.getByTestId('session-row').filter({ hasText: 'Research to keep' }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click({ button: 'right' })
    await h.page.getByText('Move to…', { exact: true }).click()
    await h.page
      .getByRole('combobox', { name: 'Workspace', exact: true })
      .selectOption(`local:${target}`)
    const move = h.page.getByRole('button', { name: 'Move', exact: true })
    await h.page
      .getByRole('checkbox', { name: /I understand this uses the target/ })
      .check({ timeout: 30_000 })
    await expect(move).toBeEnabled({ timeout: 30_000 })
    await expect(
      h.page.getByText('The conversation moves into this folder.', { exact: false }),
    ).toBeVisible()
    await move.click()
    await expect(h.page.getByText(/Moved to This Mac · Destination/)).toBeVisible({
      timeout: 30_000,
    })
    const files = await readdir(sessionDir(agent, target))
    const copy = join(
      sessionDir(agent, target),
      files.find(
        (name) => name.startsWith('2026-08-22T22-56-30-785Z_') && name.endsWith('.jsonl'),
      )!,
    )
    const copied = (await readFile(copy, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(copied[0]).toMatchObject({ cwd: target })
    expect(copied[0].id).not.toBe(id)
    expect(copied[1].name).toBe('Research to keep')
    expect(copied.at(-1)).toMatchObject({
      type: 'custom_message',
      customType: 'phosphor-lane-moved',
    })
    expect(await readFile(source, 'utf8')).toBe(original)
    await expect
      .poll(async () => {
        const prefs = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8'))
        return { pinned: prefs.pinnedSessions.includes(copy), marker: prefs.laneMarkers[copy] }
      })
      .toEqual({ pinned: true, marker: '🔬' })
    await h.page.getByRole('button', { name: 'Done', exact: true }).click()
  } finally {
    await shutdown(h)
  }
})

const BRANCH = 'agustin/arena-e2e'
const TITLE = 'Arena to move'
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@phosphor.invalid',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@phosphor.invalid',
    },
  }).trim()

/** A clean lane on its own branch in one repository, and an unrelated second repository. */
async function seedGitLane() {
  const root = await realpath(await scratchDir('phosphor-e2e-move-git-'))
  const workspace = join(root, 'source')
  const target = join(root, 'destination')
  const profile = join(root, 'profile')
  const agent = privateAgentDir()
  for (const repo of [workspace, target]) {
    await mkdir(repo)
    git(repo, 'init', '-b', 'main')
    // launch() writes this file into the lane's folder; committed, the lane stays clean.
    await writeFile(join(repo, 'hello.ts'), 'export function hello() {\n  return "new"\n}\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
  }
  git(workspace, 'checkout', '-b', BRANCH)
  await mkdir(profile)
  await mkdir(sessionDir(agent, workspace), { recursive: true })
  const source = join(sessionDir(agent, workspace), fileName)
  const original = transcript(workspace, TITLE, 'Keep building the arena.')
  await writeFile(source, original)
  await writeFile(
    join(profile, 'config.json'),
    JSON.stringify({
      lastWorkspacePath: workspace,
      recentWorkspaces: [
        { path: workspace, name: 'Source' },
        { path: target, name: 'Destination' },
      ],
    }),
  )
  return { root, workspace, target, profile, agent, source, original }
}

async function chooseTarget(page: Page, row: Locator, target: string) {
  await row.click({ button: 'right' })
  await page.getByText('Move to…', { exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Workspace', exact: true })
    .selectOption(`local:${target}`)
}

test('Move to… lands a git lane in a new worktree, lists and opens it, then refuses its taken branch', async () => {
  const s = await seedGitLane()
  const h = await launch({ workspace: s.workspace, agentDir: s.agent, userDataDir: s.profile })
  try {
    const rows = h.page.getByTestId('session-row').filter({ hasText: TITLE })
    const sourceRow = h.page
      .locator('[data-testid="session-row"][data-workspace="source"]')
      .filter({ hasText: TITLE })
    const move = h.page.getByRole('button', { name: 'Move', exact: true })
    await expect(sourceRow).toBeVisible({ timeout: 30_000 })
    await expect(h.page.getByTestId('workspace-switcher')).toContainText('source')
    await chooseTarget(h.page, sourceRow, s.target)
    await h.page
      .getByRole('checkbox', { name: /I understand this uses the target/ })
      .check({ timeout: 30_000 })
    await move.click()
    await expect(h.page.getByText(/Moved to This Mac · Destination/)).toBeVisible({
      timeout: 30_000,
    })
    const cwd = join(s.target, '.phosphor', 'worktrees', BRANCH.replaceAll('/', '-'))
    const copy = join(sessionDir(s.agent, cwd), (await readdir(sessionDir(s.agent, cwd)))[0]!)
    expect(JSON.parse((await readFile(copy, 'utf8')).split('\n')[0]!)).toMatchObject({ cwd })
    expect(await readFile(s.source, 'utf8')).toBe(s.original)

    // The new worktree's lane is listed with no other activity, then Open reaches it.
    await expect(rows).toHaveCount(2, { timeout: 15_000 })
    await h.page.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(h.page.getByText('Move lane', { exact: true })).toBeHidden({ timeout: 15_000 })
    // The stub replays no old messages; the active workspace shows where Open went.
    await expect(h.page.getByTestId('workspace-switcher')).toContainText('destination')
    await expect(h.page.getByTestId('branch-chip')).toContainText(BRANCH)

    // Moving it there again is refused by the check, before Move can be pressed.
    await chooseTarget(h.page, sourceRow, s.target)
    await expect(h.page.getByRole('list', { name: 'Why this lane cannot move' })).toHaveText(
      `A branch named ${BRANCH} already exists in destination.`,
      { timeout: 30_000 },
    )
    await expect(move).toBeDisabled()
    await h.page.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally {
    await shutdown(h)
    await rm(s.root, { recursive: true, force: true })
    await rm(s.agent, { recursive: true, force: true })
  }
})
