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

import { DEFAULT_REGISTRY, registryNamed } from '../shared/launch-settings'

/**
 * Where the registry's API is: the account calls, the directory, the relay
 * path, this machine's own line. In 0.6.0 that is a host of its own
 * (api.cookrew.dev): cookrew.dev itself is a static site and answers none of
 * it. `COOKREW_REGISTRY` moves it, for a test deployment or a self-hosted one.
 */
export function registryOrigin(): string {
  return process.env.COOKREW_REGISTRY ? registryNamed(process.env.COOKREW_REGISTRY) : DEFAULT_REGISTRY
}

/**
 * Where the site is: the pages people share (`https://cookrew.dev/@drej/team`).
 * A link to one is read as a published name and resolved at the registry's
 * API; nothing is ever asked of the site itself. A registry somebody moved
 * (`COOKREW_REGISTRY`) is its own site unless `COOKREW_SITE` says otherwise,
 * so a test instance never treats production's pages as its own.
 */
export function siteOrigin(): string {
  return siteOriginOf(registryOrigin())
}

/** The site that goes with a registry: the same rule, for a caller that was handed its registry. */
export function siteOriginOf(registry: string): string {
  if (process.env.COOKREW_SITE) return process.env.COOKREW_SITE
  // A registry of one's own is named as its own site; the home registry's pages are the site's, not the API host's.
  return registry === DEFAULT_REGISTRY ? 'https://cookrew.dev' : registry
}

/**
 * Where the console is: the one web page that reaches the account's machines.
 * Links and QR codes handed to a phone point here, and it is the one origin a
 * machine lets call its API from a page. `COOKREW_CONSOLE` moves it, beside
 * `COOKREW_REGISTRY`.
 */
export function consoleOrigin(): string {
  return process.env.COOKREW_CONSOLE || 'https://console.cookrew.dev'
}
