import type { LaneSummary } from '@phosphor/shared/host-protocol'
import { probeDeadline, probeQueue, type ProbeSlot } from './probe-queue'
import { join } from 'node:path'
import { configModels } from '@phosphor/session-runtime/pi/config-models'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { HOST_FILE_POLICY, settingsFile } from '@phosphor/session-runtime/pi/settings-file'
import {
  MACHINE_COMMANDS_LIMIT,
  machineModelDefaults,
  parseMachineCommands,
  parseMachineModels,
} from '@phosphor/shared/host-protocol-machine'
import type { FeatureContext } from './feature'
import { CatalogueCache, catalogueIdentity } from './catalogue-cache'
import {
  FeatureFailure,
  featureInspection,
  queryMachine,
  type CataloguePi,
  type MachinePorts,
} from './machine'

function config(dir: string, file: string): Record<string, unknown> {
  try {
    return settingsFile(join(dir, file), HOST_FILE_POLICY).raw
  } catch {
    return {}
  }
}
function modelAnswer(
  dir: string,
  models: NonNullable<ReturnType<typeof parseMachineModels>>,
  source: 'pi' | 'config',
) {
  const defaults = machineModelDefaults(config(dir, 'settings.json'))
  return { models, source, ...(defaults ? { defaults } : {}) }
}
function fallback(dir: string) {
  const models = configModels(config(dir, 'models.json').providers)
  return modelAnswer(dir, parseMachineModels(models) ?? [], 'config')
}
async function modelsFromPi(
  pi: CataloguePi,
  dir: string,
  home: string,
  slot: ProbeSlot,
  background: boolean,
) {
  const raw = await queryMachine(
    pi,
    home,
    'get_available_models',
    background ? 90_000 : undefined,
    slot,
  )
  if (Array.isArray(raw) && raw.length > 1000) throw new FeatureFailure('too-large')
  const models = parseMachineModels(raw)
  if (!models) throw new FeatureFailure('internal')
  return modelAnswer(dir, models, 'pi')
}
async function commandsFromPi(pi: CataloguePi, cwd: string, slot: ProbeSlot) {
  const raw = await queryMachine(pi, cwd, 'get_commands', undefined, slot)
  if (Array.isArray(raw) && raw.length > MACHINE_COMMANDS_LIMIT)
    throw new FeatureFailure('too-large')
  const commands = parseMachineCommands(raw)
  if (!commands) throw new FeatureFailure('internal')
  return { commands }
}

/** Legacy readers cannot recognize a partial answer. Their budget expires as a failure,
 * even when they join a longer background probe that another reader started. */
async function foreground<T>(probe: Promise<T>, waitMs: number, fromConfig?: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      probe,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FeatureFailure('internal')), waitMs)
      }),
    ])
  } catch (error) {
    if (!fromConfig || (error instanceof FeatureFailure && error.code === 'too-large')) throw error
    return fromConfig()
  } finally {
    clearTimeout(timer)
  }
}

export function machineCatalogues(context: FeatureContext, ports: MachinePorts) {
  const modelQueue = probeQueue()
  const resourceQueue = probeQueue()
  const models = new CatalogueCache<ReturnType<typeof modelAnswer>>()
  const commands = new CatalogueCache<Awaited<ReturnType<typeof commandsFromPi>>>()
  const skills = new CatalogueCache<unknown>()
  let inspectedPi = ports.pi
  const pi = async () => ports.pi ?? (await featureInspection(context, ports)).pi
  const key = (dir: string, pi: CataloguePi, scope?: string) =>
    JSON.stringify([ports.generation?.(), catalogueIdentity(dir, pi), scope])
  return {
    resourceQueue,
    modelWindow({ provider, id }: NonNullable<LaneSummary['model']>) {
      const dir = piAgentDir(inspectedPi?.environment.env ?? context.env, context.home)
      const match = (answer: ReturnType<typeof modelAnswer> | undefined) =>
        answer?.models.find((model) => model.provider === provider && model.id === id)
          ?.contextWindow
      const cached = inspectedPi && match(models.peek(key(dir, inspectedPi)))
      return cached || match(fallback(dir))
    },
    async models(partial: boolean) {
      const deadline = probeDeadline()
      let dir = piAgentDir(ports.pi?.environment.env ?? context.env, context.home)
      return foreground(
        (async () => {
          const launch = await pi()
          if (!launch) throw new FeatureFailure('internal')
          inspectedPi = launch
          dir = piAgentDir(launch.environment.env, context.home)
          return models.get(key(dir, launch), () =>
            modelQueue(
              (slot) => modelsFromPi(launch, dir, context.home, slot, partial),
              partial ? performance.now() + 90_000 : deadline,
            ),
          )
        })(),
        partial ? 1500 : deadline - performance.now(),
        partial ? () => fallback(dir) : undefined,
      )
    },
    async commands(repositoryId?: string, deadline = probeDeadline()) {
      const repo =
        repositoryId && context.store.listRepositories().find((r) => r.id === repositoryId)
      if (repositoryId && !repo) throw new FeatureFailure('bad-request')
      const cwd = repo ? repo.path : context.home
      const launch = await pi()
      if (!launch) throw new FeatureFailure('internal')
      const dir = piAgentDir(launch.environment.env, context.home)
      return commands.get(key(dir, launch, cwd), () =>
        resourceQueue((slot) => commandsFromPi(launch, cwd, slot), deadline),
      )
    },
    async skills(
      cwd: string,
      project: boolean,
      deadline: number,
      read: (pi: CataloguePi, slot: ProbeSlot) => Promise<unknown>,
    ) {
      const launch = await pi()
      if (!launch) throw new FeatureFailure('internal')
      const dir = piAgentDir(launch.environment.env, context.home)
      return skills.get(key(dir, launch, JSON.stringify([cwd, project])), () =>
        resourceQueue((slot) => read(launch, slot), deadline),
      )
    },
  }
}
