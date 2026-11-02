import type { GlobalInstructions } from '@shared/global-instructions'

/**
 * Where one machine's global instructions are read and saved: pi's global
 * context file in that machine's agent directory. This Mac and each Host keep
 * their own; nothing syncs between them.
 */
export interface InstructionsSource {
  /** Unique per machine. Monaco keys its model and undo stack on it. */
  key: string
  /** Who owns the file, as the header names it: "This Mac" or a Host's label. */
  machine: string
  read: () => Promise<GlobalInstructions>
  /** Refused when the file changed on disk since `revision` was read. */
  save: (content: string, revision: string) => Promise<GlobalInstructions>
}

/** This computer's own file, through main. */
export function localInstructions(machine: string): InstructionsSource {
  return {
    key: 'local',
    machine,
    read: () => window.phosphor.invoke('pi:readInstructions'),
    save: (content, revision) => window.phosphor.invoke('pi:writeInstructions', content, revision),
  }
}

/** A Host's file, through its revision-checked machine settings. */
export function hostInstructions(hostId: string, machine: string): InstructionsSource {
  const file = (settings: { instructions?: GlobalInstructions }): GlobalInstructions => {
    if (!settings.instructions) throw new Error('Update this Host to edit its instructions here.')
    return settings.instructions
  }
  return {
    key: `host-${hostId}`,
    machine,
    read: async () =>
      file(await window.phosphor.invoke('hosts:settingsRead', hostId, 'instructions')),
    save: async (content, revision) =>
      file(
        await window.phosphor.invoke('hosts:settingsPatch', hostId, {
          section: 'instructions',
          revision,
          change: { type: 'instructions.write', content },
        }),
      ),
  }
}

export const fileName = (path: string): string => path.split(/[\\/]/).pop() || path

/** "12.3 KB": bytes as they will be sent with every request. */
export function sizeLabel(text: string): string {
  const bytes = new TextEncoder().encode(text).length
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
