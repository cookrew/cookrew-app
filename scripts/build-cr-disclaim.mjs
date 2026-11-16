// Build the browser cards' Chrome launcher (resources/cr-disclaim/cr-disclaim.c)
// at install time. Plain C on clang, so the Command Line Tools are enough. On
// any other OS, or with no clang, this says so and exits 0: cards still work,
// Chrome is just spawned directly and macOS may say Cookrew was "prevented
// from modifying apps".

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'resources', 'cr-disclaim')
const source = path.join(dir, 'cr-disclaim.c')
const binary = path.join(dir, 'cr-disclaim')

if (process.platform !== 'darwin') {
  console.log('cr-disclaim: not macOS, skipping (responsibility is a macOS idea)')
  process.exit(0)
}

const fresh = existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs
if (fresh) {
  console.log('cr-disclaim: up to date')
  process.exit(0)
}

try {
  // The app's floor (Electron's LSMinimumSystemVersion), not the build Mac's:
  // a launcher an older dyld cannot load would kill every card with no fallback.
  execFileSync('clang', ['-O2', '-Wall', '-mmacosx-version-min=11.0', '-o', binary, source], { stdio: 'inherit' })
  console.log(`cr-disclaim: built ${binary}`)
} catch (error) {
  console.log(`cr-disclaim: NOT built (${error instanceof Error ? error.message : String(error)}) — install the Command Line Tools (xcode-select --install)`)
}
