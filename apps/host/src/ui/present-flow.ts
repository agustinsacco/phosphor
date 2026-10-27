import type { SetupView, StepMark } from '../commands/guided-setup'
import type { UpdateStep } from '../update/fetch'
import type { EnrollmentCode } from '../control/command'
import { showEnrollment } from './present-control'
import { commands, nextStep } from './present-reports'
import type { Busy, Screen } from './screen'
import type { Tone } from './theme'

/** A Host message line's tone, from the words its fixed texts use. */
export function lineTone(line: string): Tone {
  if (/^(warning\b|the control plane is not answering|this release speaks)/i.test(line))
    return 'warn'
  if (/\b(could not|failed|refusing|invalid|not supported|no valid)\b/i.test(line)) return 'fail'
  return 'info'
}

/** Prints the lines a command reports as they come, keeping the last for its closing line. */
export function messageLines(screen: Screen) {
  let last: string | null = null
  const flush = () => {
    if (last !== null) screen.say(commands(screen.paint, last), lineTone(last))
    last = null
  }
  const print = (line: string) => {
    flush()
    last = line
  }
  return {
    print,
    /** Prints the held line, so the closing line is the fallback. */
    flush,
    /** The last line closes the screen, or `fallback`'s last line when there was none. */
    close(exitCode: number, fallback: string) {
      if (last === null) for (const line of fallback.split('\n')) if (line) print(line)
      const text = last ?? fallback
      last = null
      const tone = exitCode === 0 ? 'done' : exitCode === 130 ? 'warn' : 'fail'
      if (exitCode === 0 || exitCode === 130) return screen.close(text, tone)
      screen.say(nextStep(screen.paint, text), 'fail')
      screen.close(`Stopped (exit ${exitCode}).`, 'fail')
    },
  }
}

/** A flow that may wait for enrollment: one spinner at a time, the code when it comes. */
export function enrollmentFlow(screen: Screen) {
  let busy: Busy | null = null
  const flow = {
    working(text: string) {
      busy?.clear()
      busy = screen.busy(text)
    },
    /** Ends the spinner as a line, or prints the line when none is spinning. */
    finish(line: string, tone: Tone) {
      if (busy) busy.done(line, tone)
      else screen.say(line, tone)
      busy = null
    },
    settle() {
      busy?.clear()
      busy = null
    },
    enrollment(code: EnrollmentCode) {
      flow.settle()
      showEnrollment(screen, code)
      const minutes = Math.max(1, Math.round(code.expiresInMs / 60_000))
      flow.working(`Waiting for approval in Phosphor · the code expires in ${minutes} min`)
    },
    print: (line: string) => screen.say(commands(screen.paint, line), lineTone(line)),
  }
  return flow
}

/** Wide enough for setup's longest step name, "Tailscale access", and a gap. */
const NAME = 17
const MARK_TONE: Record<StepMark, Tone> = { ok: 'ok', warn: 'warn', skip: 'skip', unknown: 'info' }

/** Guided setup on a screen: each step spins until its row replaces it. */
export function screenSetupView(screen: Screen) {
  const { paint } = screen
  const flow = enrollmentFlow(screen)
  const view: SetupView = {
    open: (hostname) => screen.open('Phosphor setup', hostname),
    working: flow.working,
    row(mark, name, text) {
      flow.finish(`${paint('bold', name.padEnd(NAME))} ${commands(paint, text)}`, MARK_TONE[mark])
    },
    end(code, text) {
      flow.settle()
      if (code === 0) return screen.close(text)
      if (code === 130) return screen.close('Cancelled. Steps already done are kept.', 'warn')
      screen.say(nextStep(paint, text), 'fail')
      screen.close(`Setup stopped (exit ${code}). Run phosphor setup again once fixed.`, 'fail')
    },
  }
  return { view, enrollment: flow.enrollment, print: flow.print, settle: flow.settle }
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** An update's steps as spinners that finish into lines. */
export function updateProgress(screen: Screen): (step: UpdateStep) => void {
  let busy: Busy | null = null
  /** What the open spinner says once it is done. */
  let finished = ''
  const next = (text: string, done: string) => {
    busy?.clear()
    busy = screen.busy(text)
    finished = done
  }
  const finish = (text = finished, tone: Tone = 'ok') => {
    if (busy) busy.done(text, tone)
    else screen.say(text, tone)
    busy = null
  }
  const settle = () => {
    if (busy) finish()
  }
  return (step) => {
    switch (step.step) {
      case 'check':
        return next('Checking for a new Host release', '')
      case 'found':
        return step.version === step.installed
          ? finish(`Host ${step.installed} is the latest release`, 'done')
          : finish(`Host ${step.version} is available (installed: ${step.installed})`)
      case 'download':
        return next(
          `Downloading and verifying ${step.version} · ${megabytes(step.bytes)}`,
          `Downloaded and verified ${step.version}`,
        )
      case 'restart':
        settle()
        return next(`Restarting the Host service on ${step.version}`, 'Service restarted')
      case 'health':
        finished = `The Host is up and healthy on ${step.version}`
        return busy?.update(`Waiting for the Host to come up healthy on ${step.version}`)
      case 'rollback':
        finish('The new version did not come up healthy', 'fail')
        return next(`Rolling back to ${step.version}`, `Rolled back to ${step.version}`)
      case 'provider':
      case 'selected':
        return settle()
    }
  }
}
