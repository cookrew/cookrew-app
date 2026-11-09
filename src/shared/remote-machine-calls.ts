/**
 * THE CALLS ONE MACHINE MAKES ON ANOTHER OF THE ACCOUNT, FROM ITS ZOOM VIEW
 * (owner 2026-11-10, design B). The other machine is entered with the full key
 * this one holds for it (main/machine-keys.ts), and there that key is an owner's
 * pairing: the account's machines trust each other with full control (owner,
 * 2026-11-09). So these are not a sandbox. Words to a terminal reach a shell as
 * they would from this machine's own card; the watch's refusals of shells and of
 * words into a menu are a wrist's, not an owner's. What this list does is keep
 * the relay to what a card does (read cards, answer, stop, start, look at and
 * touch an item, take a screen's control) and nothing else: no raw keys, no
 * workspace edits, no settings, no unlock. Checked here, once, in main, before
 * anything leaves.
 */

export interface RemoteMachineCall {
  readonly method: 'GET' | 'POST'
  readonly route: string
  /** A picture: answered as bytes, not JSON. */
  readonly binary: boolean
}

const ID = '[A-Za-z0-9_-]{1,128}'
const ALLOWED: readonly { method: 'GET' | 'POST'; pattern: RegExp; binary?: true }[] = [
  { method: 'GET', pattern: new RegExp(`^api/watch/cards(\\?workspace=${ID})?$`) },
  { method: 'POST', pattern: new RegExp(`^api/terminal/${ID}/(input|menu|seen)$`) },
  { method: 'POST', pattern: new RegExp(`^api/watch/card/${ID}/stop$`) },
  { method: 'POST', pattern: new RegExp(`^api/watch/new(\\?seat=${ID})?$`) },
  { method: 'GET', pattern: new RegExp(`^api/watch/item/${ID}/frame\\?w=\\d{1,4}(&peek=1)?$`), binary: true },
  { method: 'GET', pattern: new RegExp(`^api/watch/item/${ID}$`) },
  { method: 'POST', pattern: new RegExp(`^api/watch/item/${ID}/input$`) },
  // Control of a screen card on it, taken and given back as a phone does (use-source-routes.ts), in the workspace it is in.
  { method: 'POST', pattern: new RegExp(`^api/use/sources/control\\?seat=${ID}$`) }
]

/** The call, if it is one a machine may make on another; null for anything else. */
export function remoteMachineCall(method: unknown, route: unknown): RemoteMachineCall | null {
  if ((method !== 'GET' && method !== 'POST') || typeof route !== 'string' || route.length > 300) return null
  const allowed = ALLOWED.find((one) => one.method === method && one.pattern.test(route))
  return allowed ? { method, route, binary: allowed.binary === true } : null
}

/** What a call answers (main/zoom-fleet.ts · answerOf): status 0 is "nothing answered". */
export type RemoteMachineAnswer =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: number; readonly picture: { readonly type: string; readonly data: string } }
