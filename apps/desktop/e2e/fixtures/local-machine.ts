import { localMachineLabel } from '../../../../libs/client-ui/src/lib/localMachine'

/**
 * What the app under test calls its own machine. Electron runs on the runner's
 * platform, so CI on Linux reads "This computer" where a Mac reads "This Mac".
 */
export const LOCAL_MACHINE_LABEL = localMachineLabel(process.platform)
