/**
 * A real process for the owner-lock tests: acquire with the default ports,
 * report one JSON line, hold until stdin closes, then release and report again.
 * argv: <agentDir> <desktop|daemon>
 */
import { acquireOwnerLock, OwnerLockUnavailable } from '../owner-lock'
import { OwnerLockBusy } from '../types'

const [agentDir, owner] = process.argv.slice(-2)
const report = (value: object) => process.stdout.write(JSON.stringify(value) + '\n')

async function main() {
  if (owner !== 'desktop' && owner !== 'daemon') throw new Error('owner must be desktop or daemon')
  let lock
  try {
    lock = await acquireOwnerLock(agentDir!, owner)
  } catch (error) {
    if (error instanceof OwnerLockBusy) return report({ busy: error.holder })
    if (error instanceof OwnerLockUnavailable) return report({ unavailable: error.reason })
    throw error
  }
  report({ acquired: lock.record })
  process.stdin.resume()
  await new Promise((resolve) => process.stdin.once('end', resolve))
  await lock.release()
  report({ released: true })
}

main().catch((error: unknown) => {
  report({ error: String(error) })
  process.exitCode = 1
})
