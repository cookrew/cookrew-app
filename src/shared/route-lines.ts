/**
 * THE LINES THE SETUP CARD MAY BE ASKED TO TYPE.
 *
 * Every "do it" button in the Routing panel lands as one command line in a
 * real shell on the owner's Mac. The lines come from main's RouteState
 * (route/setup.ts) — but a RouteState also travels over the companion API
 * and the relay, and a renderer must not turn an arbitrary string it was
 * handed into shell. So the renderer refuses anything that is not one of
 * these shapes, whoever sent it — and the shapes admit no shell
 * metacharacter anywhere: no `$`, backtick, `;`, `|` outside the two fixed
 * install pipes, `&`, `<`, `>`, quote (but the plugin path's own single
 * quotes), `\`, newline. A key line ends in a space: the user pastes the
 * key and presses Enter themselves.
 */

/** A path inside single quotes may hold a space (a packaged "Cookrew Dev.app"); unquoted it may not. */
const PLUGIN_PATH_QUOTED = "'[A-Za-z0-9._/@~ -]+'"
const PLUGIN_PATH_BARE = '[A-Za-z0-9._/@~-]+'

export const ROUTE_LINE_PATTERNS: readonly RegExp[] = [
  /^curl -fsSL https:\/\/usemagpie\.ai\/install\.sh \| sh$/,
  /^magpie (serve|autostart on)$/,
  new RegExp(`^magpie plugin add (${PLUGIN_PATH_QUOTED}|${PLUGIN_PATH_BARE})$`),
  /^magpie provider add [a-z0-9-]+ ?$/,
  /^magpie accounts add codex$/,
  /^magpie group add smart models=[A-Za-z0-9./:,_-]+ routing=smart$/,
  /^npm i(nstall)? -g @[a-z0-9-]+\/[a-z0-9-]+$/,
  /^(claude|claude login|codex login|opencode auth login)$/,
  /^curl -fsSL https:\/\/opencode\.ai\/install \| bash$/,
  /^brew install [A-Za-z0-9._/@-]+$/
]

export function setupLineAllowed(line: string): boolean {
  if (line.length > 400 || /[\r\n\x00]/.test(line)) return false
  return ROUTE_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

/** The bare stem the renderer appends a preset to; main's ADD_KEY_STEM. */
export const KEY_STEM = 'magpie provider add '
/** An older main sent the stem with a literal placeholder where the preset goes. */
const KEY_PLACEHOLDER = 'magpie provider add <preset> '

/**
 * `magpie provider add ` + preset + a trailing space for the paste. Holds
 * whatever main sends for the key line: the bare stem, or the stem with the
 * literal `<preset>` placeholder. Anything else is null — a renderer that
 * guessed would have the user paste the key as the provider's NAME.
 */
export function keyLineFor(addKeyLine: string, preset: string): string | null {
  if (!/^[a-z0-9-]+$/.test(preset)) return null
  if (addKeyLine === KEY_STEM || addKeyLine === KEY_PLACEHOLDER) return `${KEY_STEM}${preset} `
  return null
}
