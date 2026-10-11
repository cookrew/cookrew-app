/**
 * THE LINES THE SETUP CARD MAY BE ASKED TO TYPE.
 *
 * Every "do it" button in the Routing panel lands as one command line in a
 * real shell on the owner's Mac. The lines come from main's RouteState
 * (route/setup.ts) — but a RouteState also travels over the companion API
 * and the relay, and a renderer must not turn an arbitrary string it was
 * handed into shell. So the renderer refuses anything that is not one of
 * these shapes, whoever sent it. A key line ends in a space: the user
 * pastes the key and presses Enter themselves.
 */
export const ROUTE_LINE_PATTERNS: readonly RegExp[] = [
  /^curl -fsSL https:\/\/usemagpie\.ai\/install\.sh \| sh$/,
  /^magpie (serve|autostart on)$/,
  /^magpie plugin add \S+$/,
  /^magpie provider add [a-z0-9-]+ ?$/,
  /^magpie accounts add codex$/,
  /^magpie group add smart models=[A-Za-z0-9./:,_-]+ routing=smart$/,
  /^npm i(nstall)? -g @[a-z0-9-]+\/[a-z0-9-]+$/,
  /^(claude|claude login|codex login|opencode auth login)$/,
  /^curl -fsSL https:\/\/opencode\.ai\/install \| bash$/,
  /^brew install \S+$/
]

export function setupLineAllowed(line: string): boolean {
  if (line.length > 400 || /[\r\n]/.test(line)) return false
  return ROUTE_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

/** The `magpie provider add ` stem a preset is appended to; null when main's line is not that stem. */
const KEY_STEM = /^magpie provider add $/

/**
 * `magpie provider add ` + preset + a trailing space for the paste. Null when
 * main's addKeyLine is not the bare stem — a renderer that guessed would have
 * the user paste the key as the provider's NAME.
 */
export function keyLineFor(addKeyLine: string, preset: string): string | null {
  if (!KEY_STEM.test(addKeyLine)) return null
  if (!/^[a-z0-9-]+$/.test(preset)) return null
  return `${addKeyLine}${preset} `
}
