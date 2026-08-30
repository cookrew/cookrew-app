import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * BROWSER STORAGE GC — the two halves the profile reaper never covered, and the
 * caches Chrome writes whatever we ask it not to.
 *
 * Cookrew keeps browser bytes in THREE places and only one of them was swept:
 *
 *   userData/interactive-browser/<nodeId>   the headless Chrome profile — reaped
 *   userData/Partitions/browser-<nodeId>    the canvas webview's own storage
 *   Caches/cookrew/interactive-browser/<id> Chrome's cache half, macOS-only
 *
 * Measured on the author's machine before this landed: 89 live cards, 0 orphaned
 * profiles (that reaper works), but 103 orphaned partitions and 110 orphaned
 * cache dirs — because `removeBrowserProfile` only ever knew about userData. On
 * macOS Chrome splits a profile across Application Support and Caches, so
 * deleting one and not the other leaves half of every retired card behind.
 *
 * THE COMPONENT CACHES ARE NOT A LEAK — they are the design working as Chrome
 * intends, which is the harder problem. `headlessLaunchArgs` already passes
 * --disable-component-update and disables OptimizationGuideModelDownloading,
 * OnDeviceModel and friends, and Chrome downloads them anyway through the
 * component updater: a profile created the day this was written still had 49MB
 * of optimization-guide models and 22MB of TTS wasm. Eighty-nine profiles each
 * fetching its own copy is 11GB of identical data.
 *
 * So this does not argue with Chrome. It deletes the directories afterwards.
 * Every path in REGENERABLE_PROFILE_DIRS is a cache Chrome rebuilds on demand;
 * none of them holds a cookie, a login, or site storage, and a test pins that
 * distinction. Purging costs a re-download. It must never cost a re-login.
 */

/** Caches and downloaded components. Rebuilt on demand; never user state. */
export const REGENERABLE_PROFILE_DIRS: readonly string[] = [
  // Downloaded components and on-device models — the 86% of a profile.
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
  'Crowd Deny',
  'TrustTokenKeyCommitments',
  'segmentation_platform',
  // GPU/shader caches.
  'GraphiteDawnCache',
  'GrShaderCache',
  'ShaderCache',
  // Web caches. Service Worker is here on purpose: one site had grown a 637MB
  // worker cache by itself, and a worker re-installs from the network.
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnWebGPUCache',
  'Default/DawnGraphiteCache',
  'Default/Service Worker'
]

const PARTITION_PREFIX = 'browser-'

/**
 * The node id inside a canvas partition directory name, or null.
 *
 * Null is the important answer: Electron puts every partition this app ever
 * asks for in one directory, so a reaper that assumed every entry belonged to a
 * browser card would delete another feature's storage. Only `browser-<id>` is
 * ours, and only when there is an id after the prefix.
 */
export function partitionIdOf(dirName: string): string | null {
  if (!dirName.startsWith(PARTITION_PREFIX)) return null
  const id = dirName.slice(PARTITION_PREFIX.length)
  return id.length > 0 ? id : null
}

function removeDir(target: string): boolean {
  if (!existsSync(target)) return false
  const stat = lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

/**
 * Reap canvas webview partitions whose browser card is gone.
 *
 * `ownedBrowserIds` must be the strict, fail-closed enumeration the profile
 * reaper already uses: a partial list here deletes live storage.
 */
export function reapOrphanPartitions(
  root: string,
  ownedBrowserIds: Iterable<string>
): string[] {
  if (!existsSync(root)) return []
  const owned = new Set(ownedBrowserIds)
  const removed: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const id = partitionIdOf(entry.name)
    if (id === null || owned.has(id)) continue
    if (removeDir(path.join(root, entry.name))) removed.push(entry.name)
  }
  return removed
}

function dirBytes(dir: string): number {
  let total = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          // A file Chrome removed mid-walk contributes nothing.
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
 * Delete the regenerable half of one profile and answer the bytes freed.
 *
 * Safe to call on a profile that has none of them, and safe to call twice.
 * NOT safe to call while that profile's Chrome is running — the caller must
 * check, because Chrome holds these files open and half-deleting a live
 * component store is how a profile gets corrupted.
 */
export function purgeRegenerableProfileData(profileDir: string): number {
  if (!existsSync(profileDir)) return 0
  let freed = 0
  for (const rel of REGENERABLE_PROFILE_DIRS) {
    const target = path.join(profileDir, rel)
    if (!existsSync(target)) continue
    const bytes = dirBytes(target)
    if (removeDir(target)) freed += bytes
  }
  return freed
}
