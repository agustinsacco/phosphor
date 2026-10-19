import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'

export async function attachHostDiagnostics(info: TestInfo, root: string): Promise<void> {
  await info.attach('claude-fixture.log', {
    body: (await readFile(join(root, 'claude-fixture.log'), 'utf8').catch(() => '')).slice(-131072),
    contentType: 'text/plain',
  })
  await info.attach('host-runtime.log', {
    body: (
      await readFile(join(root, 'state/phosphor-host/logs/phosphor.log'), 'utf8').catch(() => '')
    ).slice(-131072),
    contentType: 'text/plain',
  })
}
