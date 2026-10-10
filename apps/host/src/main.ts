import { homedir, hostname } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from './cli'
import { stopProbes } from './machine/probe'
import { createShutdown, SHUTDOWN_SIGNALS } from './shutdown'

// Each probe and each pi leads its own process group, so a terminal's Ctrl-C
// reaches neither: the Host stops them on the way out. A second signal
// kills every group at once.
const shutdown = createShutdown({
  exit: (code) => process.exit(code),
  stderr: (text) => process.stderr.write(text),
  stopProbes,
})
for (const signal of SHUTDOWN_SIGNALS) process.on(signal, () => void shutdown.signal(signal))
process.on('uncaughtException', (error) => void shutdown.fatal(error))
process.on('unhandledRejection', (error) => void shutdown.fatal(error))

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  {
    env: process.env,
    platform: process.platform,
    uid: process.getuid?.(),
    home: homedir(),
    hostname: hostname(),
    nodeVersion: process.versions.node,
    // The bundle's own folder, which holds pi-ext/ beside it.
    defaultResourceRoot: dirname(fileURLToPath(import.meta.url)),
    attach: shutdown.attach,
  },
)
