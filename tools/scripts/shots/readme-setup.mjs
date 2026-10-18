import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export async function prepareReadmeShots({ outDir, piStub }) {
  await mkdir(outDir, { recursive: true })

  // A named scratch project, not an mkdtemp slug: the folder name IS the
  // workspace chip in every shot, and it reads better as a project than as
  // `phosphor-shots-Qk2p1A`. Seeded as a git repo so the branch chip is real.
  const root = await mkdtemp(join(tmpdir(), 'phosphor-shots-'))
  const workspace = join(root, 'welcome-app')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'hello.ts'), 'export function hello() {\n  return "old"\n}\n')
  await writeFile(
    join(workspace, 'README.md'),
    '# welcome-app\n\nA tiny demo project used to show Phosphor in its own README.\n',
  )
  const git = (args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'shots@phosphor.dev'])
  git(['config', 'user.name', 'Phosphor shots'])
  git(['add', '-A'])
  git(['commit', '-m', 'initial'])

  // Never the developer's real ~/.pi: the stub writes session files, and prefs
  // go to a userData dir main.ts derives from its own pid for e2e runs.
  const agentDir = mkdtempSync(join(tmpdir(), 'phosphor-shots-agent-'))

  const env = { ...process.env, NODE_ENV: 'production' }
  for (const key of ['ELECTRON_RENDERER_URL', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_CLI_ARGS']) {
    delete env[key]
  }
  Object.assign(env, {
    PHOSPHOR_PI_STUB: piStub,
    PHOSPHOR_E2E_WORKSPACE: workspace,
    PHOSPHOR_TEST_USER_DATA: '1',
    PI_CODING_AGENT_DIR: agentDir,
    // Mapped windows on purpose. The e2e suite leaves windows unmapped so no
    // run steals your screen, but an unmapped window never repaints cleanly:
    // captures come out with stale layers ghosting through the new frame.
    // A screenshot run is allowed to be seen — that is what it is for.
    PHOSPHOR_E2E_SHOW: '1',
  })

  return { root, workspace, agentDir, env }
}
