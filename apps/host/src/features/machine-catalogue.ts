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
import { CatalogueCache, catalogueIdentity, probeQueue } from './catalogue-cache'
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
async function modelsFromPi(pi: CataloguePi, dir: string, home: string) {
  const raw = await queryMachine(pi, home, 'get_available_models', 90_000)
  if (Array.isArray(raw) && raw.length > 1000) throw new FeatureFailure('too-large')
  const models = parseMachineModels(raw)
  if (!models?.length) throw new FeatureFailure('internal')
  return modelAnswer(dir, models, 'pi')
}
async function commandsFromPi(pi: CataloguePi, cwd: string) {
  const raw = await queryMachine(pi, cwd, 'get_commands', 90_000)
  if (Array.isArray(raw) && raw.length > MACHINE_COMMANDS_LIMIT)
    throw new FeatureFailure('too-large')
  const commands = parseMachineCommands(raw)
  if (!commands) throw new FeatureFailure('internal')
  return { commands }
}

/** Cold models get a short foreground budget, not a short pi lifetime. */
async function foreground<T>(probe: Promise<T>, fromConfig: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      probe,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fromConfig()), 1500)
      }),
    ])
  } catch (error) {
    if (error instanceof FeatureFailure && error.code === 'too-large') throw error
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
  const pi = async () => ports.pi ?? (await featureInspection(context, ports)).pi
  const key = (dir: string, pi: CataloguePi, scope?: string) =>
    JSON.stringify([ports.generation?.(), catalogueIdentity(dir, pi), scope])
  return {
    resourceQueue,
    async models() {
      let dir = piAgentDir(ports.pi?.environment.env ?? context.env, context.home)
      return foreground(
        (async () => {
          const launch = await pi()
          if (!launch) throw new FeatureFailure('internal')
          dir = piAgentDir(launch.environment.env, context.home)
          return models.get(key(dir, launch), () =>
            modelQueue(() => modelsFromPi(launch, dir, context.home)),
          )
        })(),
        () => fallback(dir),
      )
    },
    async commands(repositoryId?: string) {
      const repo =
        repositoryId && context.store.listRepositories().find((r) => r.id === repositoryId)
      if (repositoryId && !repo) throw new FeatureFailure('bad-request')
      const cwd = repo ? repo.path : context.home
      const launch = await pi()
      if (!launch) throw new FeatureFailure('internal')
      const dir = piAgentDir(launch.environment.env, context.home)
      return commands.get(key(dir, launch, cwd), () =>
        resourceQueue(() => commandsFromPi(launch, cwd)),
      )
    },
    async skills(cwd: string, project: boolean, read: (pi: CataloguePi) => Promise<unknown>) {
      const launch = await pi()
      if (!launch) throw new FeatureFailure('internal')
      const dir = piAgentDir(launch.environment.env, context.home)
      return skills.get(key(dir, launch, JSON.stringify([cwd, project])), () =>
        resourceQueue(() => read(launch)),
      )
    },
  }
}
