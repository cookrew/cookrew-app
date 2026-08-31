/**
 * HOW FAR A SERVED ADDRESS CARRIES — the pluggable transport, named once.
 *
 * A door on a laptop's own network and a door behind cookrew.dev are both
 * "serving", and the product used to present them identically: one address,
 * no indication of who could open it. That is how someone shares a 192.168
 * link with a colleague in another city.
 *
 * The four are the ladder, not a preference. `relay` is what the product will
 * hand out by default once it exists; `lan` and `tailnet` are what an owner
 * already has today; `public` is the escape hatch for someone who wants no
 * middle at all. Everything downstream reads THIS rather than guessing from
 * the shape of a URL — which is what makes adding the relay a new value here
 * instead of a rewrite.
 *
 * Mirrors DoorTransport in registry/src/doors.ts. Two modules because one is
 * the app's own state and the other is what a directory recorded; they must
 * agree, and a test pins that they do.
 */
export type ServeTransport = 'lan' | 'tailnet' | 'public' | 'relay'

/** Can a link on this transport be opened by someone not on the owner's network? */
export function reachesOutsiders(transport: ServeTransport): boolean {
  return transport === 'public' || transport === 'relay'
}
