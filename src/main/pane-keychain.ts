import { execFileSync } from 'node:child_process'

/**
 * A KEY A PANE CAN READ, HELD BY THE MAC'S KEYCHAIN (box round 3, N4).
 *
 * A harness asks for its key by a command, and Pi asks on every request, so the
 * read has to be quick and has to work with the app closed: a pane outlives it.
 * The `security` tool does both, in 24 ms. Reading through Cookrew could not:
 * it would stop every agent the moment the app quit.
 *
 * WHAT THIS IS AND IS NOT. The value is encrypted at rest, in no file of ours and
 * no backup of ~/.cookrew. It is not kept from the owner's own processes: the item
 * trusts /usr/bin/security, so any of them can read it, as they could the 0600 file
 * it replaces. secrets-store.ts dropped this form for sealed secrets for that reason,
 * and they have a way in with an audit line; a harness has only a command to run. A
 * served seat is kept out by the deny on ~/Library/Keychains (owner-secrets.ts):
 * without it the seat's rules read a canary here, measured 2026-11-06.
 *
 * Written over stdin, as hex: `security -w <value>` would show it to `ps`, and hex
 * needs no quoting. Proved 2026-11-06: claude 2.1.316, codex 0.166 and pi 1.4 each
 * sent the right Bearer to a loopback fake from this command, newline and all.
 */

const SECURITY = '/usr/bin/security'
const ACCOUNT = 'cookrew'
const BUDGET_MS = 5_000

/** How a harness gets its key: a command, whose output is the key. */
export interface KeyReader {
  readonly command: string
  readonly args: readonly string[]
}

export interface PaneKeychain {
  /** True only once the pane's own read gives the value back. Never throws. */
  put: (name: string, value: string) => boolean
  remove: (name: string) => void
  reader: (name: string) => KeyReader
}

/** Not `cookrew-secret-`: secrets-store's migrate deletes those. */
const serviceOf = (name: string): string => `cookrew-pane-${name}`

const readArgs = (name: string): string[] => ['find-generic-password', '-a', ACCOUNT, '-s', serviceOf(name), '-w']

export type SecurityRun = (args: readonly string[], input?: string) => string

const runSecurity: SecurityRun = (args, input) =>
  execFileSync(SECURITY, [...args], { input, encoding: 'utf8', timeout: BUDGET_MS, stdio: ['pipe', 'pipe', 'ignore'] })

export function macKeychain(run: SecurityRun = runSecurity): PaneKeychain {
  return {
    put: (name, value) => {
      try {
        const hex = Buffer.from(value).toString('hex')
        run(['-i'], `add-generic-password -U -a ${ACCOUNT} -s ${serviceOf(name)} -T ${SECURITY} -X ${hex}\n`)
        return run(readArgs(name)).replace(/\n$/, '') === value
      } catch {
        return false
      }
    },
    remove: (name) => {
      try {
        run(['delete-generic-password', '-a', ACCOUNT, '-s', serviceOf(name)])
      } catch {
        // Nothing there, which is what was wanted.
      }
    },
    reader: (name) => ({ command: SECURITY, args: readArgs(name) })
  }
}
