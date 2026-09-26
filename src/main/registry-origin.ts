/**
 * THE REGISTRY THIS APP TALKS TO — asked in one place, by everyone.
 *
 * It was already configuration in most of the app (`COOKREW_REGISTRY`, so a
 * test deployment and a self-hosted one are not compiled out), but the
 * expression that read it had been written three times: account-v2 for the
 * account calls, v2-call-token for the door keys, and — as a compile-time
 * CONSTANT rather than a read — import-session, for the origin a bare
 * `@handle/team` is resolved at.
 *
 * That third copy is why this file exists. An app pointed at a local registry
 * still resolved published names at cookrew.dev, so an isolated QA instance's
 * lookup left the machine; the same shape one file over had already posted
 * invented passwords at production. Three readings of one setting is three
 * chances for one of them to be a literal, and a literal is a deployment
 * nobody can move.
 *
 * Kept in main deliberately: the renderer has no environment, and a shared
 * module reading process.env would be a bundle-time surprise rather than a
 * setting. Surfaces that need it in the renderer are handed it (see
 * pairing-url.ts, which takes the origin rather than naming one).
 */

/** Where cookrew.dev — or whatever stands in for it — is. */
export function registryOrigin(): string {
  return process.env.COOKREW_REGISTRY || 'https://cookrew.dev'
}
