import type { MagpieWebOpen } from './route/magpie-web'

/**
 * MAGPIE'S PAGE IN A CARD, ITS KEY NEVER IN THE CARD (lane Magpie, scope 3).
 *
 * Magpie's page signs a browser in by a cookie named after its port whose value
 * is the page's key (magpie 0.1.3935: `?k=<key>` answers 303 and sets
 * `magpie_web_<port>=<key>; HttpOnly`). A link with `?k=` in a browser card's
 * URL would be saved in the workspace, sent to the wall and the phone, and kept
 * in the card's tabs. So main sets the cookie straight into the card's own
 * browser session, both kinds a card can have (the desktop webview's partition,
 * and the headless Chrome behind a streamed card), and the renderer is handed
 * the bare address. The cookie is a session cookie: it is not written to the
 * profile for good, and opening Magpie's settings again signs the card in again.
 *
 * What is left (the TOCTOU): magpie-web.ts confirms the listener on the port is
 * the child it started before this runs. A same-user program that takes the port
 * after that check and before the card's request (the child died in between)
 * would be sent the cookie. A served seat cannot take the port (sandbox-deny.ts).
 */

/** What a card id may look like before it is put into a partition name. */
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface PartitionCookie {
  readonly url: string
  readonly name: string
  readonly value: string
  readonly httpOnly: true
  readonly sameSite: 'lax'
}

export interface CdpCookie {
  readonly name: string
  readonly value: string
  readonly url: string
  readonly domain: string
  readonly path: string
  readonly httpOnly: true
  readonly sameSite: 'Lax'
}

export interface MagpieCardDeps {
  /** The Magpie switch, read now. */
  readonly switchedOn: () => boolean
  readonly open: () => Promise<MagpieWebOpen>
  /** Electron: session.fromPartition(partition).cookies.set(details). */
  readonly setPartitionCookie: (partition: string, cookie: PartitionCookie) => Promise<void>
  /** Headless Chrome: set on the running instance, and on any instance started for this card later this run. */
  readonly primeHeadless: (browserId: string, cookies: readonly CdpCookie[]) => Promise<void>
}

export type MagpieCardAnswer = { readonly ok: true; readonly url: string; readonly port: number } | { readonly ok: false; readonly why: string }

export async function openMagpieCardSession(browserId: unknown, deps: MagpieCardDeps): Promise<MagpieCardAnswer> {
  if (typeof browserId !== 'string' || !CARD_ID_RE.test(browserId)) return { ok: false, why: 'Not a card.' }
  let on = false
  try {
    on = deps.switchedOn()
  } catch {
    on = false
  }
  if (!on) return { ok: false, why: 'Magpie is switched off in Launch settings.' }
  const page = await deps.open()
  if (!page.ok) return { ok: false, why: page.why }
  const { name, value } = page.cookie
  try {
    await deps.setPartitionCookie(`persist:browser-${browserId}`, { url: page.url, name, value, httpOnly: true, sameSite: 'lax' })
    await deps.primeHeadless(browserId, [{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax', url: page.url }])
  } catch {
    // The error could quote the cookie; say only what failed.
    return { ok: false, why: 'Could not sign the card in to Magpie’s page.' }
  }
  return { ok: true, url: page.url, port: page.port }
}
