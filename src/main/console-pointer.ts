/**
 * A MACHINE OF AN ACCOUNT DOES NOT HAND OUT ITS APP AT ITS OWN ADDRESS (0.6.0).
 *
 * The way into a machine of an account is the console: one page for all of
 * the account's machines, where the person signs in and proves it is them.
 * So a browser that opens this machine's own address from another device gets
 * one sentence saying that, and the link. The API on the same port answers as
 * it always did: the console's direct path goes there, with this machine's
 * token in a header.
 *
 * WHO STILL GETS THE PAGE:
 *   a machine with no account   scanning its QR on the same Wi-Fi is the only
 *                               door it has, so it serves its page to anyone
 *                               who holds its token, as before.
 *   this machine's own operator on loopback: a developer's browser and the
 *                               perf and QA harnesses open it there. Loopback
 *                               reached through the relay's bridge is NOT
 *                               that: it is the most remote client there is.
 *
 * Pure: the decision and the page, from facts handed in.
 */
import { isLoopbackPeer } from './relay-base'
import { originOf } from '../shared/pairing-url'
import { isMachineId } from '../shared/machine-relay'

export interface ConsolePointerInput {
  /** Is this machine signed in to an account. */
  readonly signedIn: boolean
  readonly remoteAddress: string | undefined
  /** The request came down the relay's bridge. */
  readonly viaRelay: boolean
  readonly consoleOrigin: string
  readonly machineId: string | null
  readonly machineName: string
}

/** What the page's policy allows: its own small style, and nothing else at all. */
export const CONSOLE_POINTER_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const DEFAULT_CONSOLE = 'https://console.cookrew.dev'

const text = (raw: string): string => raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** The page to answer with, or null to serve the app's own page. */
export function consolePointerFor(input: ConsolePointerInput): string | null {
  if (!input.signedIn) return null
  if (isLoopbackPeer(input.remoteAddress) && !input.viaRelay) return null
  // An address this app would not send anybody to is not linked to: the console's own name is.
  const console = originOf(input.consoleOrigin) ?? DEFAULT_CONSOLE
  const id = input.machineId?.toLowerCase() ?? null
  const link = id !== null && isMachineId(id) ? `${console}/d/${id}` : `${console}/`
  const name = text(input.machineName)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${name} · Cookrew</title>
<style>body{margin:0;min-height:100vh;display:grid;place-content:center;gap:12px;padding:24px;background:#f4efe4;color:#1d1a16;font:16px/1.5 Georgia,serif}a{color:#8f5520}@media(prefers-color-scheme:dark){body{background:#161412;color:#efe8da}a{color:#e2b866}}</style>
</head>
<body>
<p><b>${name}</b> is on your Cookrew account.</p>
<p>Open it from the console: <a href="${text(link)}">${text(new URL(console).host)}</a></p>
</body>
</html>
`
}
