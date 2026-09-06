// Build the Mac's ear (resources/cr-listen/cr-listen.m) at install time.
//
// Objective-C on clang, on purpose: it needs only the Command Line Tools,
// whereas swiftc has been seen broken by a stale toolchain modulemap. On any
// other OS, or with no clang, this says so and exits 0 — the app runs fine
// without a microphone, and the mic button explains itself in words.

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'resources', 'cr-listen')
const source = path.join(dir, 'cr-listen.m')
const binary = path.join(dir, 'cr-listen')

if (process.platform !== 'darwin') {
  console.log('cr-listen: not macOS, skipping (desktop voice-in is Mac only)')
  process.exit(0)
}

const fresh = existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs
if (fresh) {
  console.log('cr-listen: up to date')
  process.exit(0)
}

try {
  execFileSync(
    'clang',
    ['-fobjc-arc', '-O2', '-o', binary, source, '-framework', 'Foundation', '-framework', 'Speech', '-framework', 'AVFoundation'],
    { stdio: 'inherit' }
  )
  console.log(`cr-listen: built ${binary}`)
} catch (error) {
  console.log(`cr-listen: NOT built (${error instanceof Error ? error.message : String(error)}) — install the Command Line Tools (xcode-select --install) for desktop voice-in`)
}
