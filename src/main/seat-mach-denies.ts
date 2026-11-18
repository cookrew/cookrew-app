/**
 * SERVICES A SEAT MUST NOT ASK TO ACT FOR IT (Seatbelt lane, 2026-11-18).
 *
 * Seatbelt binds the confined process and nothing it talks to. A system service
 * that does something ON BEHALF of its client does it from its own process, past
 * every rule in the seat's profile. The seat's only way to ask is a mach-lookup
 * of the service, so that lookup is what is denied. Every entry here was run for
 * real (tests/served-fetch-services.test.ts): RED without the line, GREEN with it.
 *
 * FETCH FOR THE CALLER, which voids the loopback, gateway and IPv6 denies:
 *
 *   nsurlsessiond (background URLSession). From inside the profile a background
 *   upload reached a 127.0.0.1 and a ::1 listener on a denied port and returned
 *   the reply. Its launchd plists (LaunchDaemons and LaunchAgents
 *   com.apple.nsurlsessiond.plist) register exactly these two names.
 *
 *   WebKit's Networking process (WKWebView). On a base where curl to 127.0.0.1
 *   was denied, a WKWebView loaded it. The seat profile's default-deny base
 *   already stops WebKit coming up at all; this line makes that a decision
 *   instead of a side effect. An XPC service bundled in a framework is looked up
 *   by service name, hence the xpc-service-name filter.
 *
 * THE OWNER'S CLIPBOARD, which is the owner's data, not the seat's:
 *
 *   pboard. From inside the profile a seat read a pasteboard another process
 *   wrote, so it could read whatever the owner copies (a password, a key) and
 *   write into it (a command the owner then pastes). Universal Clipboard's
 *   client rides the same agent.
 *
 * Measured and left alone, with the reasons in the release notes: trustd (TLS
 * needs it, and it fetched nothing on loopback even unconfined), cfprefsd (it
 * refused the seat's write to the owner's preferences), mobileassetd and geod
 * (fixed Apple endpoints, no caller URL).
 *
 * Literal names, not broad prefixes: a prefix matching a service added in a
 * later macOS would deny something nobody measured. WebKit's prefix is the one
 * exception, and it covers only WebKit's own bundled services.
 */

/** Daemons that make a network request for whoever asks (global launchd names). */
export const FETCHING_SERVICES: readonly string[] = [
  'com.apple.nsurlsessiond',
  'com.apple.nsurlsessiond-launchondemand'
]

/** Bundled XPC services that fetch for their client, by service-name prefix. */
export const FETCHING_XPC_PREFIXES: readonly string[] = ['com.apple.WebKit.']

/** Services that hand the owner's own data to any client. */
export const OWNER_DATA_SERVICES: readonly string[] = [
  'com.apple.pasteboard.1',
  'com.apple.coreservices.uauseractivitypasteboardclient.xpc'
]

/** Every deny, one per line; the caller places them after the mach-lookup allow. */
export function seatMachDenies(): string[] {
  return [
    ...[...FETCHING_SERVICES, ...OWNER_DATA_SERVICES].map((name) => `(deny mach-lookup (global-name "${name}"))`),
    ...FETCHING_XPC_PREFIXES.map((prefix) => `(deny mach-lookup (xpc-service-name-prefix "${prefix}"))`)
  ]
}
