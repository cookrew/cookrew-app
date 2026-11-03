/**
 * WHICH CODE THIS MAC IS SERVING — so a phone can tell it is running old code.
 *
 * A Home Screen web app on iOS stays resident for days and never reloads by
 * itself; after a Mac update it went on running the old companion until the
 * owner swiped it away (2026-10-18). The Mac now names its build on the
 * phone's event stream, and the page reloads itself when the name changes
 * (renderer/build-watch.ts).
 *
 * In a checkout the id is the commit the tree is on, read from .git without
 * a fork; a packaged app has no .git and answers its own version.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

const SHA = /^[0-9a-f]{40}$/

const refSha = (gitDir: string, ref: string): string | null => {
  try {
    const loose = readFileSync(path.join(gitDir, ref), 'utf8').trim()
    if (SHA.test(loose)) return loose
  } catch {
    // Not loose: maybe packed.
  }
  try {
    for (const line of readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ')
      if (name === ref && SHA.test(sha ?? '')) return sha
    }
  } catch {
    // No packed refs either.
  }
  return null
}

/** The short commit the checkout at `repoDir` is on, or `fallback`. */
export const readBuildId = (repoDir: string, fallback: string): string => {
  const gitDir = path.join(repoDir, '.git')
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const sha = head.startsWith('ref: ') ? refSha(gitDir, head.slice(5)) : SHA.test(head) ? head : null
    return sha ? sha.slice(0, 12) : fallback
  } catch {
    return fallback
  }
}

/** How often the checkout is looked at: a merge without a restart still reaches the phone. */
export const BUILD_CHECK_MS = 60_000
