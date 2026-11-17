import path from 'node:path'
import { cliTransport } from '../../src/main/cli-transport'

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
 * Whether the app serves NO Unix-socket CLI on this host, as the app itself
 * decides (src/main/cli-transport.ts), not as this file guesses. Tests of the
 * app's own socket (its claim, its server, the CLI's guess at its path) run
 * exactly where the app serves one; today that is every OS but Windows, and
 * the day a Windows transport lands they follow it. What the app and the CLI
 * do where there is none is tested in cli-transport.test.ts.
 *
 * The named pipe above is a TEST HARNESS only: a fake app on a pipe lets the
 * CLI's argument handling run on Windows. It is not a transport the app serves.
 */
export const NO_APP_CLI_SOCKET = cliTransport().kind !== 'unix-socket'
