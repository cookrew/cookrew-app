// The CLI flags that never take a value.
//
// The client (cli/cookrew.mjs parseArgv) used to hand every `--key` the token
// after it unless that token began with `--`. A valueless flag before a
// positional swallowed it: `cookrew note create --new "x"` made an EMPTY note,
// and `cookrew ask "A" --no-wait -` read the dash as the flag's value. These
// flags are declared now, in the client and here, and never consume a token.
//
// The client keeps its own copy of this list (it is a lone script copied next
// to the socket and imports nothing from the app); tests/cli-bool-flags.test.ts
// runs the real client against every name below, so the two cannot drift.
import type { CliRequest } from '../shared/model'

/** Every flag whose handler in socket-server.ts only checks truthiness. */
export const BOOLEAN_CLI_FLAGS: ReadonlySet<string> = new Set([
  'all',
  'canvas',
  'disabled',
  'help',
  'new',
  'no-wait',
  'rotate'
])

/**
 * A usage error when a boolean flag arrives carrying a string, or null.
 *
 * Only a client older than the declared list sends that shape, and the string
 * is an argument it swallowed. Where that argument sat among the others is
 * lost, so the request is refused rather than guessed at: `note create --new
 * "x"` would otherwise make an empty note and answer OK.
 */
export function staleBooleanFlagError(request: CliRequest): string | null {
  const swallowed = Object.entries(request.flags).find(
    ([key, value]) => BOOLEAN_CLI_FLAGS.has(key) && typeof value === 'string'
  )
  if (!swallowed) return null
  const [key, value] = swallowed
  return (
    `--${key} takes no value, but this cookrew client read "${value}" as one (an argument went missing). ` +
    'Update the CLI (npm run install-cli) or restart the app, then run the command again.'
  )
}
