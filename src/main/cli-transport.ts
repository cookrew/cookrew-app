/**
 * HOW THE `cookrew` CLI REACHES THIS APP, on a given OS: the one place that
 * says so, for the app (socket-server.ts) and for the tests that exercise the
 * transport.
 *
 * macOS and Linux: a Unix-domain socket, claimed without stealing it
 * (socket-claim.ts). Windows: NOTHING yet. It has no such socket file to bind
 * or hard-link, and the app has no named-pipe transport, so the app serves no
 * CLI there and says why instead of failing to bind. The day a transport
 * lands, this answer changes and every test gated on it runs on Windows too.
 */
export type CliTransport =
  | { readonly kind: 'unix-socket' }
  | { readonly kind: 'none'; readonly reason: string }

export const CLI_NOT_ON_WINDOWS =
  'The cookrew CLI is not available on Windows yet: the app serves it over a Unix-domain socket, and has no Windows transport.'

export function cliTransport(platform: NodeJS.Platform = process.platform): CliTransport {
  return platform === 'win32' ? { kind: 'none', reason: CLI_NOT_ON_WINDOWS } : { kind: 'unix-socket' }
}
