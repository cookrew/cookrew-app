/**
 * LOCAL NETWORK ACCESS — what a browser says about a page talking to the house.
 *
 * Chrome 142 gates a public page's requests to an address on the reader's own
 * network behind a permission. The companion no longer makes such requests by
 * name (the per-machine names under d.cookrew.dev are gone, 2026-11-16): its
 * direct path is the WebRTC link (path/rtc-adopt.ts). Two things remain here:
 *
 *   THE ANNOTATION, for a plane whose origin is itself a local address. A fetch
 *   to one is annotated `targetAddressSpace: "local"`; without it the request
 *   is not "asked and refused", it is simply blocked. `targetAddressSpace` is an
 *   ordinary `RequestInit` member and WebIDL drops members a browser does not
 *   know, so Safari, Firefox and older Chrome are unaffected.
 *
 *   THE PERMISSION, read and never asked for: the companion reports it to the
 *   Mac with each race. Nothing draws it (the WebRTC link does not need it).
 */

/** The address space a direct plane lives in, in the spec's own vocabulary. */
export type AddressSpace = 'local' | 'private' | 'public'

/** `RequestInit` as it will be once the option is in the published IDL. */
export interface AddressSpaceInit extends RequestInit {
  readonly targetAddressSpace?: AddressSpace
}

/**
 * WHICH VARIANT OF THE ANNOTATION A REQUEST ACTUALLY CARRIED.
 *
 * THE INCIDENT: Chrome 152 behind a system proxy, measured on the owner's Mac
 * on 2026-09-08. The LAN probe to `192-168-2-40.<id>.d.cookrew.dev:8643` with
 * `targetAddressSpace: 'local'` failed in 32 ms with `TypeError: Failed to
 * fetch`, the permission stayed 'prompt', and NO dialog appeared. With a proxy
 * in front of it Chrome never learns the resolved address, so it classifies the
 * target as PUBLIC — and the Local Network Access rule fails a request whose
 * declared space does not match the one the connection lands in, before any
 * prompt. Without the annotation the same request is an ordinary public →
 * public fetch, which is allowed, and the proxy's DIRECT rule for d.cookrew.dev
 * delivers it to the Mac.
 *
 * So 'local' and 'none' are not two spellings of one request: they are two
 * different requests with different outcomes, and every layer that carries one
 * — the probe, the plane, the attempt row, the report — has to be able to say
 * WHICH. On a proxy-less network the hinted variant is still the one that
 * raises the prompt, so it stays the first thing tried, always.
 */
export type AddressSpaceHint = 'local' | 'none'

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
 * The origin's host is its address: a name is never read for the address it
 * might spell (the per-machine names under d.cookrew.dev are gone, 2026-11-16),
 * so a name is judged by what it is, a name.
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
  return isLocalAddress(host)
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
