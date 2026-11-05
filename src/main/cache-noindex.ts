// SPOTLIGHT WAS READING OUR OWN BROWSER CACHE.
//
// Measured 2026-11-05: of 7,247 files indexed under the home directory in two
// hours, 3,230 were this app's Cache and Code Cache, each one a process slot in
// a queue of mdworkers on a machine that may already be paging. Excluding a path
// in Spotlight's settings takes root or a person. Probed, without root:
// `.metadata_never_index` does nothing to a folder, a directory named `.noindex`
// works, and Electron ignores --disk-cache-dir. So each cache becomes a symlink
// into `<userData>/caches.noindex`, which Chromium follows. It has to stay inside
// userData: the network service's sandbox denied a sibling `<userData>.noindex`,
// and `Cache` then failed silently (ERR_FAILED, 0 files) while pages still loaded.
//
// Must run after the single-instance lock and before `ready`: a cache is only
// safe to move while no Chromium in this profile has it open.

import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'

const INDEXED_CACHES = ['Cache', 'Code Cache']

function moveOne(userData: string, home: string, name: string): boolean {
  const link = path.join(userData, name)
  const target = path.join(home, name)
  if (isLink(link)) return repairOwnLink(userData, link, target)
  const present = existsSync(link)
  mkdirSync(home, { recursive: true })
  if (present) {
    rmSync(target, { recursive: true, force: true })
    renameSync(link, target)
  } else {
    mkdirSync(target, { recursive: true })
  }
  symlinkSync(path.relative(userData, target), link)
  return true
}

/** A link of ours whose directory went missing would leave the cache off for good. */
function repairOwnLink(userData: string, link: string, target: string): boolean {
  if (readlinkSync(link) !== path.relative(userData, target) || existsSync(target)) return false
  mkdirSync(target, { recursive: true })
  return true
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/** Returns the caches moved. Best-effort: a failure leaves a plain directory. */
export function keepCachesOutOfIndex(userData: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'darwin') return []
  const home = path.join(userData, 'caches.noindex')
  const moved: string[] = []
  for (const name of INDEXED_CACHES) {
    try {
      if (moveOne(userData, home, name)) moved.push(name)
    } catch {
      // Still in the index, and still a working cache.
    }
  }
  return moved
}
