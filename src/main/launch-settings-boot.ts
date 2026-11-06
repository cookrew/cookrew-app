import { homedir } from 'node:os'
import { bootLaunchSettings, launchSettingsPath } from './launch-settings'

/**
 * Imported first in index.ts, on purpose: modules read these variables as they
 * load, so a saved choice has to be in process.env before any of them does.
 */
export const launchBoot = bootLaunchSettings(process.env, launchSettingsPath(homedir()))
