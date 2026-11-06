/**
 * THE LAUNCH DEFAULTS — what the app does when its environment says nothing.
 *
 * Up to 0.3.0 four behaviours the owner runs every day were opt-in, switched
 * on by the launch line
 *
 *   COOKREW_REGISTRY=https://cookrew.dev COOKREW_INTERACTIVE_BROWSER=1
 *   COOKREW_MULTI_INSTANCE=1 COOKREW_MULTIPLEXER=herdr npm run dev
 *
 * and a released app has no launch line, so it shipped none of them. From
 * 0.4.0 that line IS the default. Every variable still overrides — this file
 * only decides what an unset one means, and the off switch for each is named
 * beside it. The same four can be set in the app: a saved choice arrives here
 * as the variable (launch-settings.ts).
 *
 * Main-only: the renderer has no environment (see registry-origin.ts).
 */

import { DEFAULT_MULTIPLEXER, DEFAULT_REGISTRY, type LaunchValues } from '../shared/launch-settings'

export { DEFAULT_MULTIPLEXER, DEFAULT_REGISTRY }

type Env = Readonly<Record<string, string | undefined>>

const ON = new Set(['1', 'true', 'yes', 'on'])
const OFF = new Set(['0', 'false', 'no', 'off'])

/** An explicit on/off, or null when the value says neither. */
function readSwitch(value: string | undefined): boolean | null {
  const word = value?.trim().toLowerCase() ?? ''
  if (ON.has(word)) return true
  if (OFF.has(word)) return false
  return null
}

/** 1/true/yes/on → on, 0/false/no/off → off, anything else → `fallback`. */
export function envSwitch(value: string | undefined, fallback: boolean): boolean {
  return readSwitch(value) ?? fallback
}

/**
 * Where the relay serves this Mac's doors. Unset → cookrew.dev. Set but empty
 * (`COOKREW_REGISTRY=`) → no relay at all, the pre-0.4.0 default, kept as the
 * opt-out. Note registryOrigin() still answers cookrew.dev for account calls
 * in that case: turning the relay off is not pointing the app elsewhere.
 */
export function relayOrigin(env: Env = process.env): string {
  const configured = env.COOKREW_REGISTRY
  return configured === undefined ? DEFAULT_REGISTRY : configured.trim()
}

/** Every workspace held live at once. Off: COOKREW_MULTI_INSTANCE=0. */
export function multiInstanceDefault(env: Env = process.env): boolean {
  return envSwitch(env.COOKREW_MULTI_INSTANCE, true)
}

/**
 * PAGES driven by a headless Chrome main owns (agents and the phone can drive
 * them). That needs a Chrome, so it is on exactly when one is installed, and
 * setting COOKREW_INTERACTIVE_BROWSER=1 cannot conjure one: forced on without
 * Chrome, every page came up dark (box round 3). =0 still turns it off, without
 * probing. Use cards are not decided here at all (browser-owner.ts).
 */
export function interactiveBrowserDefault(env: Env, chromeFound: () => boolean): boolean {
  return readSwitch(env.COOKREW_INTERACTIVE_BROWSER) !== false && chromeFound()
}

/**
 * The terminal host tried first. Other hosts stay behind it in the order, so
 * a machine without herdr (Windows) still falls through to tmux or direct.
 */
export function multiplexerPreference(env: Env = process.env): string {
  return env.COOKREW_MULTIPLEXER?.trim() || DEFAULT_MULTIPLEXER
}

/** All four, as the settings sheet shows them. Whether Chrome exists is not a setting. */
export function launchValues(env: Env): LaunchValues {
  return {
    registry: relayOrigin(env),
    interactiveBrowser: readSwitch(env.COOKREW_INTERACTIVE_BROWSER) !== false,
    multiInstance: multiInstanceDefault(env),
    multiplexer: multiplexerPreference(env)
  }
}

/** `current` to the character, then each dir it does not hold yet. */
export function appendedPath(current: string | undefined, dirs: readonly string[]): string {
  const held = (current ?? '').split(':')
  const missing = dirs.filter((dir, i) => dir !== '' && !held.includes(dir) && dirs.indexOf(dir) === i)
  return [current ?? '', ...missing].filter((part) => part !== '').join(':')
}

/**
 * A DOCK LAUNCH GETS THE PATH OF NOBODY'S SHELL. launchd hands a GUI app
 * /usr/bin:/bin and little else, so `tmux` from Homebrew and `herdr` in
 * ~/.local/bin both failed their probe, and the app fell to the direct backend
 * (agents die with the window) on a Mac that had what it needed. The places
 * installers use are appended, never put first, so the person's own order
 * still wins. Set before PtyManager is built: the host is chosen there, once.
 *
 * PACKAGED APPS ONLY, by the caller. A launch from a terminal has the PATH its
 * person chose, and a QA instance's safety rests on that: a PATH without herdr
 * is what keeps a second Electron off the fleet's host.
 */
export function widenedPath(env: Env, home: string, platform: string = process.platform): string {
  if (platform === 'win32') return env.PATH ?? ''
  return appendedPath(env.PATH, installerDirs(home, platform))
}

/** Where installers put a tool, whether or not any shell has been told. */
export function installerDirs(home: string, platform: string = process.platform): string[] {
  return platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.claude/local`, `${home}/.opencode/bin`]
}
