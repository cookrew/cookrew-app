import path from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'

/**
 * Where a test's fake server listens for a client under test.
 *
 * A Unix-domain socket is a file on macOS and Linux. Windows has no such file:
 * `listen()` on a path under %TEMP% fails with EACCES, and a fake app that
 * never listens left every CLI test waiting out its 5 s timeout. Node's
 * `net` speaks named pipes there through the same API, so the client under
 * test (the CLI, the vphone guest) is exercised unchanged on a pipe named
 * after the test's own temp dir, which keeps it unique per run.
 */
export function testSocketPath(dir: string, name: string): string {
  if (!IS_WINDOWS) return path.join(dir, name)
  return `\\\\.\\pipe\\cookrew-test-${path.basename(dir)}-${name}`
}

/**
 * Why a test of the app's OWN CLI socket does not run on Windows: the app
 * serves a Unix-domain socket and claims it by probing and hard-linking a
 * staged path (src/main/socket-claim.ts). Windows has neither, and the app has
 * no named-pipe transport yet, so there is no Windows behaviour to test.
 */
export const NO_APP_SOCKET_ON_WINDOWS = IS_WINDOWS
