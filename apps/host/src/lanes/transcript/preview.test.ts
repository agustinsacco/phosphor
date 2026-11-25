import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTranscriptCache } from './cache'
import { readTranscript } from './read'

it('previews the newest active messages beyond the old 64 MiB file bound', () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'large-preview-'))
  try {
    const sessionFile = join(sessionsRoot, 'lane.jsonl')
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"test"}\n')
    const data = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 65; i++) {
      appendFileSync(
        sessionFile,
        JSON.stringify({
          type: 'message',
          id: String(i),
          parentId: null,
          message: { role: 'user', content: data },
        }) + '\n',
      )
    }
    const message = { role: 'user', content: 'latest\u2028message' }
    appendFileSync(
      sessionFile,
      JSON.stringify({ type: 'message', id: 'latest', parentId: null, message }),
    )
    expect(
      readTranscript({
        sessionFile,
        sessionsRoot,
        laneId: 'lane',
        cache: createTranscriptCache(),
        onFailure: () => {},
      }),
    ).toEqual({ kind: 'messages', messages: [message] })
  } finally {
    rmSync(sessionsRoot, { recursive: true, force: true })
  }
})
