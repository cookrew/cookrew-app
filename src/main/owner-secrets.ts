import path from 'node:path'
import { homedir } from 'node:os'

/**
 * WHERE THE OWNER'S CREDENTIALS LIVE — the paths a served session may not read.
 *
 * THIS IS A DENYLIST AND THAT IS A DEMOTION, not a design. session-env.ts
 * argues the case against denylists and it is right: a list of the secrets
 * somebody thought of on the day they wrote it grows stale silently. It exists
 * anyway because the Seatbelt profile allows `file-read*` across the whole
 * disk — deliberately, since denying everything means enumerating every path a
 * toolchain touches — and a blanket read allow makes the per-service grant
 * DECORATIVE. Measured, not assumed, with the real profile:
 *
 *   owner claude credentials: READABLE
 *   another service sandbox:  READABLE
 *
 * A caller's agent could read `~/.claude/.credentials.json` — an OAuth refresh
 * token, which is an account rather than a key — without the owner lending
 * anything. So "the owner lends keys on purpose or not at all" was not true of
 * the filesystem, only of the environment.
 *
 * WHAT ACTUALLY CLOSES THIS is HOME pointing at the sandbox, which is why these
 * paths are reachable only by a process that goes looking with an absolute
 * path. This list catches the one that goes looking. Treat a new entry as a
 * patch, not as the mechanism.
 */

/**
 * Every session sandbox on the machine, so no service can read another's.
 *
 * The profile denied SIBLINGS — sessions of the same service — and left every
 * other service's sandbox readable, which the probe above confirms. One
 * subpath covers both, and the session's own sandbox is re-allowed after it.
 */
export function sessionsRootOf(base: string): string {
  return path.join(base, 'sessions')
}

/**
 * Credential stores under the owner's home.
 *
 * `.claude/.credentials.json` rather than `.claude`: the directory also holds
 * settings and plugins a harness legitimately reads, and denying the whole tree
 * breaks the agent in a way that reads as our bug. The rest are directories
 * whose entire purpose is secrets.
 */
/**
 * The owner's BROWSING identity — the three stores a browser card's login can
 * live in.
 *
 * Three and not one, because a profile is split across two roots and a second
 * mechanism entirely: Chrome keeps a user-data-dir under Application Support
 * and its cache half under Caches (macOS), and the canvas webview keeps its own
 * Electron partition. Retiring a card used to clean only the first, which is
 * how 103 orphaned partitions and 110 orphaned cache directories accumulated —
 * the same three-way split matters here for the opposite reason: a deny list
 * that knows one of them leaves the other two readable.
 *
 * Denied at the profile roots rather than at the app-support directory, which
 * would take the app's own settings with it. What is being protected is the
 * owner's logged-in sessions for every site they have opened on the canvas.
 */
export function browserStatePaths(home: string, appDir: string): readonly string[] {
  return [
    path.join(home, 'Library', 'Application Support', appDir, 'interactive-browser'),
    path.join(home, 'Library', 'Application Support', appDir, 'Partitions'),
    path.join(home, 'Library', 'Caches', appDir, 'interactive-browser')
  ]
}

/**
 * The Electron DEFAULT session's storage — the app's own origin state.
 *
 * Ruled 2026-08-30 (P2 residual). This state does not live in a profile
 * directory: Electron writes the default session's Cookies, Local Storage and
 * IndexedDB DIRECTLY under the app-support dir, beside settings a harness
 * legitimately reads — which is exactly why the tree-level deny was declined
 * (see the note below ownerSecretPaths) and why these are FILE-LEVEL entries.
 * Today it holds only what the app's own UI persists, but "only app data" is
 * a fact about today: the moment a pairing or auth token lands in the default
 * session, a served agent could read it under the blanket file-read* allow.
 * Deny the entries by name; the parent stays readable.
 *
 * The list is the entries the default session was OBSERVED writing on a live
 * install (2026-08-30), not a guess at Chromium's schema. A new entry Electron
 * starts writing is a patch here — same caveat as the top of this file: this
 * is a denylist, treat additions as patches, not as the mechanism.
 */
export function defaultSessionStatePaths(home: string, appDir: string): readonly string[] {
  const app = path.join(home, 'Library', 'Application Support', appDir)
  return [
    'Cookies',
    'Cookies-journal',
    'Local Storage',
    'IndexedDB',
    'Session Storage',
    'SharedStorage',
    'SharedStorage-wal',
    'Trust Tokens',
    'Trust Tokens-journal',
    'Network Persistent State',
    'WebStorage',
    'blob_storage'
  ].map((entry) => path.join(app, entry))
}

/**
 * The app-support directory name. Lowercase on disk while the product name is
 * capitalised, which is exactly the mismatch that would make a hand-written
 * path silently deny nothing — so callers pass what they observe.
 */
export const DEFAULT_APP_DIR = 'cookrew'

export function ownerSecretPaths(
  base: string,
  home: string = homedir(),
  appDir: string = DEFAULT_APP_DIR,
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  const at = (...parts: string[]): string => path.join(home, ...parts)
  // Magpie's config dir follows XDG when the owner set it; the default lives
  // under ~/.config. Both are denied when both could exist.
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : null
  return [
    // The owner's browsing identity: Default/Cookies for every card they ever
    // logged into. `file-read*` is allowed across the disk, so without these a
    // served agent reads every site session the owner holds, lent nothing.
    ...browserStatePaths(home, appDir),
    // …and the app's OWN origin state, entry by entry (the default session
    // writes it beside the settings, so the tree cannot be taken).
    ...defaultSessionStatePaths(home, appDir),
    // What is on the owner's screen, as files: each frame passes through the
    // first, and an agent's screenshots stay in the second.
    at('Library', 'Application Support', appDir, 'use-capture'),
    at('Library', 'Application Support', appDir, 'use-shots'),
    // The Sous ledger: every sentence the owner said to the crew, scrubbed but theirs (sous-ledger.ts).
    at(appDir === DEFAULT_APP_DIR ? '.cookrew' : appDir, 'sous-decisions.jsonl'),
    // The one the ruling names by hand.
    at('.claude', '.credentials.json'),
    // The login keychain. `security` opens this file in its own process, so the
    // read is a file read: with this denied a seat's lookup finds nothing, and
    // without it the seat rules read a canary item out (2026-11-06). Any item that
    // trusts `security` is in reach otherwise, a pane's key (pane-keychain.ts) and
    // an owner's Claude sign-in among them. A seat runs on what it is lent, so
    // nothing it is meant to have is here.
    at('Library', 'Keychains'),
    at('.claude.json'),
    at('.ssh'),
    at('.aws'),
    at('.gnupg'),
    at('.netrc'),
    at('.npmrc'),
    at('.pypirc'),
    at('.docker', 'config.json'),
    at('.kube'),
    at('.config', 'gh'),
    at('.config', 'gcloud'),
    // Cookrew's own: the hosted-Sous key and the env files a grant lends FROM.
    // A granted copy lands inside the sandbox and stays readable; the original
    // is what a service that was lent nothing must not be able to go and take.
    path.join(base, 'sous.json'),
    path.join(base, 'qwen.env'),
    path.join(base, 'stripe.env'),
    // Public data, but still owner payment configuration. The fixture binds it
    // to the same served-sandbox deny as the write-only Stripe source.
    path.join(base, 'payment.json'),
    // THE SEALED SLOTS (R4, secrets-store.ts): one 0600 file per name. The
    // served CLI refuses every read; the sandbox must refuse the files too,
    // or the refusal is theatre. And the root pairing token, which opens the
    // owner's companion to whoever holds it.
    path.join(base, 'secrets'),
    path.join(base, 'pairing-token'),
    // A person's own endpoint (agent-access.ts): its key, copied out for panes
    // to read at boot, and where it points. A seat never runs on either.
    path.join(base, 'access-keys'),
    path.join(base, 'access.json'),
    // What the owner's browser cards saved (browser-downloads.ts): chat files
    // from logged-in sites, as private as the profiles they came out of.
    path.join(base, 'downloads'),
    // Stop's hold and who is waiting to hear (remote-desk.ts).
    path.join(base, 'remote-control.json'),
    // The sealed switch (remote-switch-memory.ts): a copy could be put back after it is off.
    path.join(base, 'remote-switch'),
    path.join(base, 'remote-switch.tmp'),
    // What a phone's sealed Mac password opens under (remote-unlock.ts).
    path.join(base, 'unlock-key.json'),
    path.join(base, 'unlock-key.json.tmp'),
    // What the sealed session's keys rest on (connect-code.ts).
    path.join(base, 'connect-code'),
    // writeFileAtomic's way there: a seat that polls could catch it, and a crash leaves it.
    path.join(base, 'connect-code.tmp'),
    // THE ROUTE (HP round, audit §11): Magpie's own config — providers.json,
    // plugin-providers.json, logins.json, plugin auth — is every upstream key
    // the owner holds; the Sous ledger and its Magpie facts; the owner's
    // route choices; and the scoped gateway key Sous speaks with.
    at('.config', 'magpie'),
    ...(xdg ? [path.join(xdg, 'magpie')] : []),
    path.join(base, 'sous-decisions.jsonl'),
    path.join(base, 'sous-magpie.json'),
    path.join(base, 'route.json'),
    path.join(base, 'sous-gateway.key'),
    // The per-harness gateway key names (route program, E2E round).
    path.join(base, 'route-keys.json'),
    // The plugin file Magpie writes for this app carries `route.key`.
    path.join(base, 'magpie.json')
  ]
}
