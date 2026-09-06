/**
 * LOCAL NETWORK ACCESS — asking a browser for permission to talk to the house.
 *
 * Reach v2.1's whole fast path is a page served from a public origin opening a
 * connection to an address on the reader's own Wi-Fi. Chrome 142 gates exactly
 * that behind a permission, and the Local Network Access specification is
 * explicit about two things that between them decide whether the feature
 * exists at all on a phone:
 *
 *   THE REQUEST MUST SAY WHERE IT IS GOING. A fetch is annotated
 *   `targetAddressSpace: "local"`; without it the request is not "asked and
 *   refused", it is simply blocked, and the failure arrives as an ordinary
 *   TypeError indistinguishable from a Mac that is asleep.
 *
 *   A PUBLIC NAME THAT RESOLVES PRIVATELY GETS NO EXEMPTION. That is precisely
 *   the shape of `192-168-2-40.<id>.d.cookrew.dev`, so the certificate work
 *   that made the switch possible buys nothing here. The check is per
 *   connection — the spec requires it "for each new connection made", because
 *   a name can be re-resolved to a different address between two requests — so
 *   the annotation belongs on every request, not on a handshake.
 *
 * WHY IT IS SAFE TO SEND UNCONDITIONALLY. `targetAddressSpace` is an ordinary
 * member of the `RequestInit` dictionary. WebIDL dictionary conversion reads
 * the members it knows and DROPS everything else; an unrecognised member is
 * not an error and never has been, which is the same reason `priority` and
 * `keepalive` could ship without a feature test. So Safari, Firefox and every
 * Chrome before 142 receive an object with one extra key and behave exactly as
 * they do today. No branch, no user agent sniffing, nothing to get stale.
 *
 * WHY THE PERMISSION IS READ AND NOT ASSUMED. A prompt that appears while the
 * phone is in a pocket is a prompt that gets dismissed, and a dismissed prompt
 * is a permission that stays refused. So the state is read first and the ask
 * is a deliberate, single, user-visible moment (see LocalNetworkRow.tsx).
 * There is no retry loop in this file and there must never be one.
 */

import { addressFromTrustedName } from '../../shared/reach-names'

/** The address space a direct plane lives in, in the spec's own vocabulary. */
export type AddressSpace = 'local' | 'private' | 'public'

/** `RequestInit` as it will be once the option is in the published IDL. */
export interface AddressSpaceInit extends RequestInit {
  readonly targetAddressSpace?: AddressSpace
}

/** Everything the companion reaches directly is on the reader's own network. */
export const DIRECT_ADDRESS_SPACE: AddressSpace = 'local'

/**
 * The one init fragment a local request adds, as a fresh object every time.
 *
 * A shared frozen constant would be spread into request options all over the
 * client and one careless `Object.assign` onto it would re-point every request
 * in the app; a new object costs nothing and cannot be mutated from a distance.
 */
export const directAddressSpaceInit = (): { readonly targetAddressSpace: AddressSpace } => ({
  targetAddressSpace: DIRECT_ADDRESS_SPACE
})

/** Strip brackets so an IPv6 literal out of a URL can be matched as an address. */
const bare = (host: string): string => host.replace(/^\[/, '').replace(/]$/, '').toLowerCase()

const ipv4 = (host: string): number[] | null => {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? numbers : null
}

/**
 * IS THIS ADDRESS IN THE LOCAL ADDRESS SPACE, as the browser reckons it?
 *
 * NOT the same question as the badge's `isLanHostname`, and the difference is
 * the whole reason this exists. The badge asks "which word does a person want
 * for this path" and deliberately calls Tailscale's 100.64/10 the tailnet
 * rather than the LAN. The browser asks "which address space is this in", and
 * its answer comes from a fixed table of ranges: loopback, RFC 1918, link
 * local, and IPv6 unique-local plus link-local. 100.64/10 is CGNAT and is in
 * NONE of them, so a browser calls it public.
 *
 * That distinction is load-bearing rather than pedantic. `targetAddressSpace`
 * is an ASSERTION, and the Local Network Access specification fails a request
 * whose connection lands in a space other than the one it claimed — that is
 * precisely the rebinding defence. So claiming 'local' for a 100.64 address
 * would not merely be untidy: it would break the tailnet plane outright on
 * Chrome 142, in exactly the browsers this whole change exists to support.
 *
 * Tailscale's IPv6 ULA block (fd7a:115c:a1e0::/48) sits inside fc00::/7 and IS
 * local, which is the same fact seen from the other side: the address decides,
 * never the word we use for the network.
 */
export const isLocalAddress = (host: string): boolean => {
  const h = bare(host)
  if (h.length === 0) return false
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true
  const v4 = ipv4(h)
  if (v4) {
    if (v4[0] === 10 || v4[0] === 127) return true
    if (v4[0] === 192 && v4[1] === 168) return true
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true
    return v4[0] === 169 && v4[1] === 254
  }
  if (!h.includes(':')) return false
  // Unique-local (fc00::/7) and link-local (fe80::/10), plus loopback.
  return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
}

/**
 * The annotation for one origin, or nothing at all when it is not local.
 *
 * A trusted name spells its address in the leftmost label
 * (`192-168-2-40.<id>.d.cookrew.dev`), so the address is read back out of the
 * name rather than guessed from the zone — every one of these ends in
 * cookrew.dev, which is as public as a name gets. A bare origin, which is what
 * the navigating switch races, is its own address.
 *
 * OMITTING IT IS THE RIGHT NON-LOCAL ANSWER. An unannotated request is exactly
 * what the companion sent before Chrome 142 and is what a public target needs;
 * asserting 'public' would add a second way to be wrong for no gain.
 */
export const addressSpaceInitFor = (
  origin: string
): { readonly targetAddressSpace?: AddressSpace } =>
  isLocalOrigin(origin) ? directAddressSpaceInit() : {}

/**
 * Is this origin one the Local Network Access permission has anything to say
 * about?
 *
 * The gate that decides whether a race may run asks the same question the
 * annotation does, and it must: a permission refused because of a LAN probe at
 * home would otherwise strand a phone whose Mac is only reachable over a CGNAT
 * tailnet address — this change causing exactly the silent death it exists to
 * prevent.
 */
export const isLocalOrigin = (origin: string): boolean => {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  const address = addressFromTrustedName(host) ?? host
  return isLocalAddress(address)
}

/**
 * What this browser will do about the local network, as four honest answers.
 *
 * 'unsupported' is not a synonym for 'granted'. It means the question has no
 * meaning here — Safari today, Chrome before 142 — and the caller's response
 * is to try the request and let the network answer, because a browser that
 * never prompts either allows it or fails it and a failed request is already
 * "not this path".
 */
export type LocalNetworkState = 'unsupported' | 'granted' | 'denied' | 'prompt'

/** The descriptor name. Unknown names REJECT rather than answering 'denied'. */
export const LOCAL_NETWORK_PERMISSION = 'local-network-access'

/** The sliver of `navigator.permissions` this needs, so a test needs no browser. */
export interface PermissionsLike {
  readonly query: (descriptor: { name: string }) => Promise<{ readonly state: string }>
}

const ambientPermissions = (): PermissionsLike | null => {
  try {
    const store = (globalThis as { navigator?: { permissions?: PermissionsLike } }).navigator
      ?.permissions
    return store && typeof store.query === 'function' ? store : null
  } catch {
    // Some embedded web views throw on touching `navigator`. Not knowing is
    // the same answer as not being able to ask.
    return null
  }
}

/**
 * Read the permission, treating every kind of "I have never heard of that" as
 * 'unsupported'.
 *
 * `query` rejects with a TypeError for a descriptor name the browser does not
 * know, which is the ONLY signal Safari gives us. Catching it broadly is
 * deliberate: any failure to ask is a failure to know, and the safe reading of
 * not knowing is "carry on and let the request answer", never "refused".
 */
export const localNetworkState = async (
  permissions: PermissionsLike | null | undefined = ambientPermissions()
): Promise<LocalNetworkState> => {
  if (!permissions) return 'unsupported'
  try {
    const status = await permissions.query({ name: LOCAL_NETWORK_PERMISSION })
    const state = status?.state
    if (state === 'granted' || state === 'denied' || state === 'prompt') return state
    return 'unsupported'
  } catch {
    return 'unsupported'
  }
}

export interface LocalNetworkAsk {
  /** A trusted origin off the desktop's reach card. Never a bare IP. */
  readonly url: string
  readonly fetch?: typeof fetch
  readonly permissions?: PermissionsLike | null
  readonly timeoutMs?: number
}

/** Long enough for a prompt to be answered by a person who is looking at it. */
export const ASK_TIMEOUT_MS = 30_000

/**
 * THE ASK: one annotated request, and then read the permission again.
 *
 * The prompt is raised by the request, not by an API — there is no
 * `permissions.request()` for this — so the ask IS a probe. Exactly one, with
 * a deadline long enough for somebody to read a dialog and short enough that a
 * phone put back in a pocket does not hold a socket forever.
 *
 * The probe's own result is thrown away on purpose. A refusal, a timeout and a
 * Mac that is genuinely asleep are the same TypeError here; the permission
 * store is the only thing that can tell them apart, so it is what is returned.
 */
export const requestLocalNetwork = async (ask: LocalNetworkAsk): Promise<LocalNetworkState> => {
  const call = ask.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch
  const permissions = ask.permissions === undefined ? ambientPermissions() : ask.permissions
  if (!call) return localNetworkState(permissions)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ask.timeoutMs ?? ASK_TIMEOUT_MS)
  try {
    await call(`${ask.url}/api/hello`, {
      ...addressSpaceInitFor(ask.url),
      signal: abort.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    } as AddressSpaceInit)
  } catch {
    // Refused, blocked, asleep or not there. All four are the same event to a
    // caller of fetch, and none of them is the answer this function returns.
  } finally {
    clearTimeout(timer)
  }
  return localNetworkState(permissions)
}
