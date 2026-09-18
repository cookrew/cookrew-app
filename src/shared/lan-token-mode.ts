/**
 * DOES THE ROOT PAIRING TOKEN STILL OPEN THIS MAC (v3, H2)?
 *
 * ONE FACT, WITH TWO READERS: the gate that decides whether a root-token
 * request is served (companion-gate.ts, through mobile-server's
 * `rootEverywhere`), and the sentence that tells the owner what revoking a
 * device does (account-copy.ts · `d12.revoke`). They were separate, and they
 * disagreed: the demotion was off in every build that shipped, while the copy
 * told the owner revocation ends access "on every Mac's Wi-Fi" and the code's
 * own comment called that sentence THE SECURITY CONTRACT. A promise ahead of
 * its mechanism is worse than no promise, because it is the one that stops
 * somebody doing the thing that would actually have worked.
 *
 * WHAT IT SAYS: the companion bundle THIS BUILD serves knows how to trade the
 * root token for one of its own (`POST /api/admit`, V3-14). While that is
 * false the root has to keep opening everything, and the sentence has to say
 * so; when it is true the root is demoted to a bootstrap and the sentence is
 * the contract it was written as. Flipping it is one edit, in one file, and
 * both halves move together.
 *
 * ── WHY IT IS THIS AND NOT THE THREE OTHER SHAPES ──
 *
 * NOT AN ENVIRONMENT VARIABLE. It was one: `COOKREW_LAN_TOKEN_STRICT`, a
 * string that appears in no build config, no launch script and no running
 * environment — so the strict path was dead code and the shipped default was
 * the insecure one. A switch nobody can find is not a switch; it is a way of
 * writing "off" that reads like "configurable".
 *
 * NOT A CLOCK. A grace that expires N days after the update ships a breakage
 * on a timer: if the companion half slips, every phone the owner has stops
 * working on a date nobody chose, for a reason no screen can explain.
 *
 * NOT PER DEVICE. "Demote the root for phones that have bootstrapped" cannot
 * be expressed at this gate, and the reason is the whole premise of the lane:
 * on the LAN a root-token request carries NO device identity. The gate sees a
 * credential and nothing else, which is exactly why the per-device token had
 * to exist. A rule that needs to know who is asking cannot be the rule that
 * decides whether to ask who.
 *
 * SO IT IS A BUILD FACT, and that is not a compromise — it is the honest
 * shape. The companion is the bundle THIS Mac serves: every phone of this Mac
 * runs the code in this build, and a phone holding a cached page gets the new
 * one on its next load. "Can the companion bootstrap?" is therefore a
 * question about the build and never about the phone.
 *
 * THE FLIP IS V3-14 LANDING ON DEV, not a later decision. V3-14 is the
 * companion's half and is done on its own branch; when it merges, this
 * constant becomes true in the same commit and `d12.revoke` stops being
 * hedged. Until then the sentence names the one action that IS sufficient.
 */

/**
 * Does the companion this Mac serves know how to bootstrap a per-device
 * token? FALSE until V3-14 lands on dev — flip it there, in that commit.
 */
export const COMPANION_BOOTSTRAPS = false

/**
 * WHY THE HEDGED SENTENCE IS PESSIMISTIC RATHER THAN OPTIMISTIC.
 *
 * A phone admitted under the retired v2 ceremony holds a per-device token, so
 * revoking it DOES end its access on this Wi-Fi — for that phone the hedged
 * sentence promises less than the system does. That is the direction to be
 * wrong in here. A sentence that says "it may still work, and here is what
 * ends it" sends the owner to do something more protective; a sentence that
 * says "it is cut off" when it is not sends them to do nothing at all. Every
 * phone paired since reach v2.1 holds the root, which is all of them, so the
 * hedge describes the world as shipped and the action it names is sufficient
 * in both worlds.
 */
export const lanRevokeEnds = (): boolean => COMPANION_BOOTSTRAPS
