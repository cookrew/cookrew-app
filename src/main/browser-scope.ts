import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'

/**
 * BROWSER SCOPE — putting Chromium's installation-scope state back at
 * installation scope.
 *
 * Chromium's own layout separates the two: a `user-data-dir` is the
 * INSTALLATION container (Local State, downloaded components, on-device
 * models), and each profile subdirectory inside it holds ONE identity's
 * cookies, storage and history. Cookrew gives every browser card a whole
 * user-data-dir, so it gives every card its own copy of the installation. On
 * this machine that was 89 cards × ~127MB of identical components — 11GB of
 * duplicated models, CRX caches and TTS wasm, against 0.8GB of actual browsing.
 *
 * The obvious fix is not available: two Chrome processes cannot share one
 * user-data-dir. Chrome refuses outright — "Failed to create a ProcessSingleton
 * for your profile directory… Aborting now to avoid profile corruption" — and
 * measured here, the second instance dies while the first keeps its port. So
 * the cards keep one process and one user-data-dir each, and only the
 * installation-scope subdirectories are redirected into a single shared store.
 *
 * Symlinks, tested against two concurrent Chromes sharing one component store:
 * both started, both kept serving, and neither replaced the link.
 *
 * WHY IT IS SAFE TO REPLACE WHAT IS ALREADY THERE. Every directory listed here
 * is a cache Chrome refills on demand. Nothing in the list holds a cookie, a
 * login, or site storage, and a test pins that. The cost of being wrong is a
 * re-download; it is never a re-login.
 *
 * The flags did not work. `headlessLaunchArgs` already passes
 * --disable-component-update and disables OptimizationGuideModelDownloading,
 * OnDeviceModel and the rest, and Chrome fetches these anyway: a profile
 * created the day this was written still held 49MB of optimization-guide models
 * and 22MB of TTS wasm. This stops arguing with Chrome about whether to
 * download them and simply makes there be one copy.
 */

/**
 * Installation-scope directories: components and models Chrome downloads, which
 * are byte-for-byte the same work for every profile on the machine.
 *
 * Deliberately NOT the per-profile web caches (`Default/Cache`, `Code Cache`,
 * `Service Worker`). Those are keyed to the sites a card visited, so sharing
 * them would cross identities — a card could serve another card's cached
 * response. Reclaiming those is the sweeper's job, not this one's.
 */
export const SHARED_INSTALLATION_DIRS: readonly string[] = [
  'optimization_guide_model_store',
  'component_crx_cache',
  'WasmTtsEngine',
  'OnDeviceHeadSuggestModel',
  'Safe Browsing',
  'ActorSafetyLists',
  'ZxcvbnData',
  'CertificateRevocation',
  'SafetyTips',
  'ScreenAI',
  'Subresource Filter',
  'TpcdMetadata',
  'FileTypePolicies',
  'OriginTrials',
  'PKIMetadata',
  'MEIPreload',
  'AutofillStates',
  'OptimizationHints',
  'TrustTokenKeyCommitments'
]

function bytesOf(dir: string): number {
  let total = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          // Removed mid-walk by the browser; contributes nothing.
        }
      }
    }
  }
  try {
    walk(dir)
  } catch {
    return total
  }
  return total
}

/**
 * Point this profile's installation-scope directories at the shared store, and
 * answer the bytes reclaimed from copies it replaced.
 *
 * MUST be called while this profile's Chrome is NOT running — Chrome holds
 * these files open, and swapping a live component store for a link is how a
 * profile gets corrupted. The launch path is the natural place: it already
 * clears SingletonLock there, which is the same "nothing is attached" moment.
 *
 * Idempotent: an existing link is left exactly as it is, so a normal launch
 * does no filesystem work at all.
 */
export function shareInstallationDirs(profileDir: string, sharedRoot: string): number {
  let freed = 0
  for (const name of SHARED_INSTALLATION_DIRS) {
    const link = path.join(profileDir, name)
    const target = path.join(sharedRoot, name)
    try {
      if (existsSync(link) || lstatSync(link)) {
        const stat = lstatSync(link)
        if (stat.isSymbolicLink()) continue // already shared
        freed += bytesOf(link)
        rmSync(link, { recursive: true, force: true })
      }
    } catch {
      // lstat throws when the path is absent, which is the common case on a
      // fresh profile and means there is nothing to replace.
    }
    try {
      mkdirSync(target, { recursive: true })
      mkdirSync(path.dirname(link), { recursive: true })
      symlinkSync(target, link)
    } catch {
      // A card that cannot be shared still works — it just keeps its own copy.
      // Never let a disk optimisation stop a browser from starting.
    }
  }
  return freed
}
