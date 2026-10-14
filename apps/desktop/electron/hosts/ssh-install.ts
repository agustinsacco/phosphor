import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { normalizeUserCode, CONTROL_LIMITS } from '@shared/control-api'
import {
  validSshRepository,
  validSshTarget,
  type SshInstallEvent,
  type SshInstallStep,
} from '@shared/ssh-install'

const commands = {
  install: 'sh -s --',
  setup: '~/.local/bin/phosphor setup',
  login: '~/.local/bin/phosphor login',
  service: '~/.local/bin/phosphor service install',
}
export function sshArgs(target: string, command: string): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ClearAllForwardings=yes',
    '--',
    target,
    command,
  ]
}
export function parseSshEnrollment(output: string): { code: string; fingerprint: string } | null {
  const codeLine = /and enter: {2}([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\r?\n/.exec(
    output,
  )
  if (!codeLine) return null
  const code = normalizeUserCode(codeLine[1])
  const fingerprint =
    /(?:^|\n)Key fingerprint: ([0-9a-f]{4}(?:-[0-9a-f]{4}){3})\. Phosphor shows the same one\./.exec(
      output.slice(codeLine.index + codeLine[0].length),
    )
  const fingerprintValue =
    fingerprint?.index === 0 && fingerprint[0].startsWith('Key fingerprint: ')
      ? fingerprint[1]
      : undefined
  return code && fingerprintValue ? { code, fingerprint: fingerprintValue } : null
}
interface Job {
  id: string
  target: string
  repository: string
  owner: number
  step: SshInstallStep
  cancelled: boolean
  child?: ChildProcessWithoutNullStreams
  readyTimer?: ReturnType<typeof setTimeout>
  started?: boolean
  stopVerification?: () => void
  send: (event: SshInstallEvent) => void
}
interface Ports {
  installer: () => Promise<string>
  verifyEnrollment: (code: string, fingerprint: string) => Promise<boolean>
  log: (step: SshInstallStep, exitCode: number | null, reason: string) => void
  waitForReady?: boolean
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}
/** Jobs and remote output are memory-only, owned by the requesting window. */
export function createSshInstaller(ports: Ports) {
  const jobs = new Map<string, Job>()
  function kill(job: Job) {
    job.stopVerification?.()
    const pid = job.child?.pid
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        job.child?.kill('SIGKILL')
      }
    }
  }
  function cancel(id: unknown, owner: number) {
    if (typeof id !== 'string') return
    const job = jobs.get(id)
    if (!job || job.owner !== owner) return
    job.cancelled = true
    if (!job.started) {
      clearTimeout(job.readyTimer)
      jobs.delete(job.id)
      job.send({ kind: 'cancelled', step: job.step })
    }
    kill(job)
  }
  async function run(job: Job, input: string): Promise<boolean> {
    const step = job.step
    job.send({ kind: 'progress', step })
    let command = commands[step]
    if (step === 'setup' && job.repository) command += ` --repository "$HOME/${job.repository}"`
    return new Promise((resolve) => {
      const child = spawn('ssh', sshArgs(job.target, command), {
        detached: true,
        stdio: 'pipe',
        env: ports.env ?? process.env,
      })
      job.child = child
      let output = ''
      let loginOutput = ''
      let enrollmentSent = false
      const stopped = new Promise<boolean>((resolve) => {
        job.stopVerification = () => resolve(false)
      })
      let verified: Promise<boolean> = Promise.resolve(true)
      let timedOut = false
      let finished = false
      const timer = setTimeout(
        () => {
          timedOut = true
          kill(job)
        },
        ports.timeoutMs ?? (step === 'login' ? CONTROL_LIMITS.enrollmentTtlSec * 1000 : 600_000),
      )
      // Keep only bounded recent text, including an unterminated line.
      const receive = (text: string, stdout: boolean) => {
        output = (output + text).slice(-32768)
        if (step === 'login' && stdout && !enrollmentSent) {
          loginOutput = (loginOutput + text).slice(-32768)
          const enrollment = parseSshEnrollment(loginOutput)
          if (enrollment) {
            enrollmentSent = true
            verified = Promise.race([
              ports
                .verifyEnrollment(enrollment.code, enrollment.fingerprint)
                .catch(() => false)
                .then((matches) => {
                  if (matches && !job.cancelled && !timedOut)
                    job.send({ kind: 'enrollment', step: 'login', ...enrollment })
                  if (!matches) kill(job)
                  return matches
                }),
              stopped,
            ])
          }
        }
      }
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8')
        stream.on('data', (data: Buffer) => receive(decoder.write(data), stream === child.stdout))
        stream.on('end', () => receive(decoder.end(), stream === child.stdout))
      }
      const finish = async (code: number | null) => {
        if (finished) return
        finished = true
        job.child = undefined
        const matches = await verified
        clearTimeout(timer)
        job.stopVerification = undefined
        const reason = job.cancelled
          ? 'cancelled'
          : timedOut
            ? 'timeout'
            : code === 0 && matches
              ? 'ok'
              : 'failed'
        ports.log(step, code, reason)
        if (job.cancelled) job.send({ kind: 'cancelled', step })
        else if (code !== 0 || timedOut || !matches) {
          const message = timedOut
            ? 'This step timed out. Try again.'
            : !matches
              ? 'The fingerprints could not be verified. Do not approve this machine.'
              : code === 255
                ? `SSH could not connect. Check your keys and known_hosts by running ssh ${job.target} once in a terminal, then try again.`
                : step === 'setup' && code === 64 && !job.repository
                  ? 'Choose a repository on that machine and try again'
                  : `Host ${step} failed. Try again.`
          job.send({
            kind: 'failed',
            step,
            message,
            output: output ? output.split(/\r?\n/).slice(-20) : [],
          })
        }
        resolve(code === 0 && matches && !job.cancelled && !timedOut)
      }
      child.on('error', () => finish(null))
      child.on('close', finish)
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
      if (job.cancelled) kill(job)
    })
  }
  async function execute(job: Job) {
    try {
      const installer = await ports.installer()
      if (job.cancelled) {
        job.send({ kind: 'cancelled', step: job.step })
        return
      }
      for (const step of ['install', 'setup', 'login', 'service'] as const) {
        job.step = step
        if (!(await run(job, step === 'install' ? installer : ''))) return
        if (job.cancelled) return
      }
      job.send({ kind: 'done', step: 'service' })
    } catch {
      ports.log(job.step, null, 'unavailable')
      job.send({
        kind: 'failed',
        step: job.step,
        message: 'Host installer is unavailable. Try again.',
        output: [],
      })
    } finally {
      jobs.delete(job.id)
    }
  }
  return {
    start(target: unknown, repository: unknown, owner: number, send: Job['send']) {
      if (!validSshTarget(target) || !validSshRepository(repository))
        throw new Error('Invalid SSH install input.')
      if (jobs.size >= 8 || [...jobs.values()].some((job) => job.target === target))
        throw new Error('An SSH install is already running.')
      const job: Job = {
        id: randomUUID(),
        target,
        repository,
        owner,
        send,
        step: 'install',
        cancelled: false,
      }
      jobs.set(job.id, job)
      if (ports.waitForReady) job.readyTimer = setTimeout(() => cancel(job.id, owner), 30_000)
      else {
        job.started = true
        setTimeout(() => void execute(job), 0)
      }
      return { jobId: job.id }
    },
    ready(id: unknown, owner: number) {
      if (typeof id !== 'string') return
      const job = jobs.get(id)
      if (!job || job.owner !== owner || job.started) return
      clearTimeout(job.readyTimer)
      job.started = true
      void execute(job)
    },
    cancel,
    cancelOwner(owner: number) {
      for (const job of jobs.values()) cancel(job.id, owner)
    },
    stop() {
      for (const job of jobs.values()) cancel(job.id, job.owner)
    },
  }
}
