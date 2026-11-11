/**
 * READING A PAIRING LINK, and judging an origin fit to send a phone to.
 *
 * Until 0.6.0 this file built the one link a phone was given: the relay's page
 * for a machine, with the pairing token in its fragment. That page is gone. A
 * machine of an account now hands out its address on the console, which
 * carries no credential (main/pairing-handout.ts); a machine with no account
 * hands out its own address on the network with `?token=`.
 *
 * What is left here: the fragment keys a pasted link may still carry (a token
 * printed by `cookrew mobile --token`, read by the re-pair card on a machine's
 * own page), and the rule for an origin worth sending anybody to.
 */

/** The fragment key. Read here and, on the companion, nowhere else. */
export const PAIR_FRAGMENT = 'pair'
export const CODE_FRAGMENT = 'code'

/**
 * The origin, trimmed of trailing slashes, or null if it is not one we would
 * send a phone to.
 *
 * https only: the fragment is the credential's only protection on the phone's
 * own screen, but the shell it loads is what will hold that credential, and a
 * shell served in the clear can be rewritten in flight by anyone on the path.
 *
 * THE ONE EXCEPTION IS LOOPBACK. A registry on 127.0.0.1 is a developer's own
 * process on this same machine; nothing is on the path to rewrite anything,
 * and refusing it would leave the real pairing flow untestable end to end.
 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

export const originOf = (raw: string): string | null => {
  try {
    const url = new URL(raw)
    const clear = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    if (url.protocol !== 'https:' && !clear) return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/**
 * The token out of a fragment, or null.
 *
 * The inverse belongs beside the assembly so the two cannot drift: the
 * companion reads what this writes, and a test that round-trips them is the
 * only place the pair is checked together.
 */
export const parsePairingFragment = (hash: string): string | null => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (raw.length === 0) return null
  const found = new URLSearchParams(raw).get(PAIR_FRAGMENT)
  return found ? found : null
}
