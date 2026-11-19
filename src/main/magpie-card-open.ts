import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
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
 * Cookies are scoped by host, not port, so in the card's webview session the cookie
 * is held back from every other loopback port (stripMagpieCookies). The headless
 * Chrome behind a streamed card has no such hook: there the residual is a page the
 * card is sent to on another loopback port, which only the owner's own processes
 * can serve (a served seat may not listen at all).
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
  /** Electron: in that session, hold the cookie back from every other loopback port (stripMagpieCookies). */
  readonly guardPartition: (partition: string, port: number) => void
  /** Headless Chrome: set on the running instance, and on any instance started for this card later this run. */
  readonly primeHeadless: (browserId: string, cookies: readonly CdpCookie[]) => Promise<void>
  /** The cards main signed in before (kept on disk): only these are reused. */
  readonly signed: { has(id: string): boolean; add(id: string): void }
  readonly newId: () => string
}

export type MagpieCardAnswer =
  | { readonly ok: true; readonly url: string; readonly port: number; readonly cardId: string; readonly fresh: boolean }
  | { readonly ok: false; readonly why: string }

/** At most this many card ids are offered (every browser card of the workspace). */
const OFFER_MAX = 2000
/** How many signed card ids are remembered. */
const KEEP_SIGNED = 20

/**
 * Sign a card in to Magpie's page. The renderer offers the ids of its browser cards; main reuses
 * one only if it signed that one before (whatever it is called now), else it mints a new card id.
 * A card an agent made and named "Magpie" is never handed the cookie.
 */
export async function openMagpieCardSession(offered: unknown, deps: MagpieCardDeps): Promise<MagpieCardAnswer> {
  if (!Array.isArray(offered) || offered.length > OFFER_MAX || !offered.every((id) => typeof id === 'string' && CARD_ID_RE.test(id))) return { ok: false, why: 'Not a card.' }
  let on = false
  try {
    on = deps.switchedOn()
  } catch {
    on = false
  }
  if (!on) return { ok: false, why: 'Magpie is switched off in Launch settings.' }
  const page = await deps.open()
  if (!page.ok) return { ok: false, why: page.why }
  const known = (offered as string[]).find((id) => deps.signed.has(id))
  const browserId = known ?? deps.newId()
  if (!CARD_ID_RE.test(browserId)) return { ok: false, why: 'Not a card.' }
  const partition = `persist:browser-${browserId}`
  const { name, value } = page.cookie
  try {
    deps.guardPartition(partition, page.port)
    await deps.setPartitionCookie(partition, { url: page.url, name, value, httpOnly: true, sameSite: 'lax' })
    await deps.primeHeadless(browserId, [{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax', url: page.url }])
    deps.signed.add(browserId)
  } catch {
    // The error could quote the cookie; say only what failed.
    return { ok: false, why: 'Could not sign the card in to Magpie’s page.' }
  }
  return { ok: true, url: page.url, port: page.port, cardId: browserId, fresh: known === undefined }
}

/**
 * A request that may carry Magpie's page cookie: only to the page's own address and port, and
 * only one the page itself (or the person, typing or opening it) started. SameSite=Lax counts
 * every 127.0.0.1 port as one site, so a page on another port could otherwise post to Magpie's
 * settings with the cookie (Sec-Fetch-Site: same-site).
 */
export function cookieAllowedFor(url: string, port: number, fetchSite?: string, navigation = false): boolean {
  // No Sec-Fetch-Site and not the card's own page load: who started it cannot be told, so no cookie.
  if (fetchSite === undefined ? !navigation : fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  try {
    const u = new URL(url)
    return u.hostname === '127.0.0.1' && Number(u.port) === port
  } catch {
    return false
  }
}

/** A Cookie header without any magpie_web_* cookie. */
export function stripMagpieCookies(header: string): string {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^magpie_web_\d+=/.test(part))
    .join('; ')
}

export const MAGPIE_CARDS_FILE = 'magpie-cards.json'

/** The card ids main signed in to Magpie's page, kept 0600 so a reused card survives a restart. */
export function fileSignedCards(file: string): { has(id: string): boolean; add(id: string): void } {
  const read = (): string[] => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cards?: unknown }
      return Array.isArray(parsed.cards) ? parsed.cards.filter((id): id is string => typeof id === 'string' && CARD_ID_RE.test(id)) : []
    } catch {
      return []
    }
  }
  return {
    has: (id) => read().includes(id),
    add: (id) => {
      const cards = [...read().filter((c) => c !== id), id].slice(-KEEP_SIGNED)
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeFileAtomic(file, `${JSON.stringify({ cards })}\n`)
    }
  }
}
