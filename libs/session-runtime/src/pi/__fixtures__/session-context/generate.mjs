// Run manually when upgrading pi. No credentials, prompts or real agent directory.
// pi 0.87.1 dist/migrations.js migrateSessionsFromAgentRoot moves *.jsonl in the agent dir.
// Keep the copy outside it. main.js switches to the header cwd on --session, so
// rewrite only the disposable header cwd to avoid loading project resources there.
import { spawn, execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'

const directory = fileURLToPath(new URL('.', import.meta.url))
const version = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim()
await writeFile(join(directory, 'PI_VERSION'), `${version}\n`)
for (const name of (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()) {
  const temporary = await mkdtemp(join(tmpdir(), 'phosphor-context-'))
  try {
    const input = join(temporary, 'input')
    const home = join(temporary, 'home')
    const agent = join(temporary, 'agent')
    const cwd = join(temporary, 'cwd')
    await Promise.all([input, home, agent, cwd].map((path) => mkdir(path)))
    const session = join(input, name)
    const source = await readFile(join(directory, name), 'utf8')
    const lines = source.split('\n')
    let rewritten = false
    let hasMessages = false
    for (const [index, line] of lines.entries()) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (!rewritten) {
        if (entry?.type !== 'session' || typeof entry.id !== 'string')
          throw new Error(`invalid fixture header in ${name}`)
        lines[index] = JSON.stringify({ ...entry, cwd })
        rewritten = true
      }
      hasMessages ||= entry?.type === 'message'
    }
    if (!rewritten) throw new Error(`missing fixture header in ${name}`)
    await writeFile(session, lines.join('\n'))
    const child = spawn('pi', ['--mode', 'rpc', '--session', session], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.resume()
    try {
      const messages = await new Promise((resolve, reject) => {
        let pending = ''
        const timer = setTimeout(() => reject(new Error(`pi did not answer ${name}`)), 30_000)
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('exit', () => {
          clearTimeout(timer)
          reject(new Error(`pi exited before answering ${name}`))
        })
        child.stdout.on('data', (data) => {
          pending += data.toString('utf8')
          let newline
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline)
            pending = pending.slice(newline + 1)
            let frame
            try {
              frame = JSON.parse(line)
            } catch {
              continue
            }
            if (frame.id !== 'golden') continue
            clearTimeout(timer)
            if (!frame.success || !Array.isArray(frame.data?.messages))
              reject(new Error(`pi rejected get_messages for ${name}`))
            else resolve(frame.data.messages)
          }
        })
        child.stdin.write(`${JSON.stringify({ id: 'golden', type: 'get_messages' })}\n`)
      })
      await access(session)
      if (hasMessages && messages.length === 0)
        throw new Error(`unexpected empty golden for ${name}`)
      const golden = `${JSON.stringify(messages, null, 2)}\n`
      if (golden.includes(temporary) || golden.includes('/tmp/'))
        throw new Error(`temporary path in golden for ${name}`)
      await writeFile(join(directory, name.replace('.jsonl', '.messages.json')), golden)
      console.log(`generated ${name}`)
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      if (child.exitCode === null && child.signalCode === null) await exited
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
