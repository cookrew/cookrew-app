import { DEFAULT_PORT } from './discovery'

/**
 * THE GATEWAY IS THE OWNER'S, NOT A SEAT'S (route program, fix round 1).
 *
 * The served-session Seatbelt profile allows network so a stranger's agent
 * can fetch its packages and reach its own vendors — and that allow covers
 * loopback. Magpie takes ANY key from this machine and counts the call under
 * it, so a seat could `curl 127.0.0.1:<port>/v1/messages` and spend the
 * owner's subscriptions, with no env var involved at all. These clauses
 * deny outbound to the gateway's port — the one discovered and the default,
 * on any host, since a port is the only stable name a loopback service has.
 *
 * Seatbelt takes the LAST matching rule, so the caller places these after
 * its `(allow network*)`; sandbox-deny.test.ts pins both the text and, on a
 * Mac, the connect itself.
 */
export function gatewayDenyClauses(ports: readonly number[]): string[] {
  const distinct = [...new Set([...ports, DEFAULT_PORT])].filter((p) => Number.isInteger(p) && p > 0 && p < 65536).sort((a, b) => a - b)
  return distinct.map((port) => `(deny network-outbound (remote ip "*:${port}"))`)
}
