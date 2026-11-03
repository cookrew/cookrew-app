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
 * beside it.
 *
 * Main-only: the renderer has no environment (see registry-origin.ts).
 */

type Env = Readonly<Record<string, string | undefined>>

export const DEFAULT_REGISTRY = 'https://cookrew.dev'
export const DEFAULT_MULTIPLEXER = 'herdr'

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
 * Browser cards driven by a headless Chrome main owns (agents and the phone
 * can drive them). That needs a Chrome, so with nothing set it is on exactly
 * when one is installed — otherwise every browser card would come up blank.
 * An explicit COOKREW_INTERACTIVE_BROWSER wins both ways, without probing.
 */
export function interactiveBrowserDefault(env: Env, chromeFound: () => boolean): boolean {
  return readSwitch(env.COOKREW_INTERACTIVE_BROWSER) ?? chromeFound()
}

/**
 * The terminal host tried first. Other hosts stay behind it in the order, so
 * a machine without herdr (Windows) still falls through to tmux or direct.
 */
export function multiplexerPreference(env: Env = process.env): string {
  return env.COOKREW_MULTIPLEXER?.trim() || DEFAULT_MULTIPLEXER
}
