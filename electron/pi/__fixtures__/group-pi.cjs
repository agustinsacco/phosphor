// A pi-like parent with a stubborn nested provider. Tests routine group cleanup.
const { fork } = require('node:child_process')
if (process.env.GROUP_FIXTURE_CHILD === '1') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  process.send('ready')
} else {
  const child = fork(__filename, [], {
    env: { ...process.env, GROUP_FIXTURE_CHILD: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const ready = new Promise((resolve) => child.once('message', resolve))
  process.stdin.on('data', async (chunk) => {
    await ready
    for (const line of chunk.toString().trim().split('\n')) {
      const command = JSON.parse(line)
      process.stdout.write(
        JSON.stringify({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
          data: { sessionId: String(child.pid) },
        }) + '\n',
      )
    }
  })
  process.on('SIGTERM', () => process.exit(0))
}
