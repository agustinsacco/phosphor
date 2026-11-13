import { expect, it } from 'vitest'
import { runPrintMode } from './print-mode'

it('writes optional UTF-8 input and closes stdin, including an empty input', async () => {
  for (const input of ['Harbor café\n'.repeat(10000), '']) {
    const result = await runPrintMode(process.execPath, ['-e',
      "process.stdin.setEncoding('utf8'); let s = ''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write(s || 'EMPTY'))",
    ], { cwd: process.cwd(), env: {}, input, timeoutMs: 5000 })
    expect(result).toEqual({ stdout: input || 'EMPTY' })
  }
})

it('handles a child closing its input before the entire prompt is written', async () => {
  const result = await runPrintMode(process.execPath, ['-e', 'process.stdin.destroy(); process.exit(0)'], {
    cwd: process.cwd(), env: {}, input: 'x'.repeat(2 * 1024 * 1024), timeoutMs: 5000,
  })
  expect(result.reason).toBeUndefined()
})
