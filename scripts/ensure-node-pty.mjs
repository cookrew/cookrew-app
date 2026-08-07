// Leave node-pty usable even when the native rebuild fails.
//
// THE TRAP THIS CLOSES
// --------------------
// postinstall runs `electron-rebuild -f -w node-pty`. Its first act is a gyp
// clean, which deletes build/Release — including `spawn-helper`, the small
// binary node-pty execs to fork a PTY on Unix. If the rebuild then fails (a
// missing or mismatched C++ toolchain is enough: "fatal error: 'functional'
// file not found"), npm reports an install error and moves on, and the tree is
// left WORSE than before: a previously working checkout can no longer spawn a
// terminal.
//
// The failure surfaces far from its cause. `require('node-pty')` still loads,
// every test still passes, and the app starts — then spawning any terminal
// dies with a bare "posix_spawnp failed", which reads as an app bug rather
// than as a broken install.
//
// node-pty ships prebuilt helpers for exactly these platforms, so the repair
// is a copy. This does NOT pretend to replace the rebuild: if the ABI-matched
// binary is missing there is nothing to fix and the script says so.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pty = path.join(root, 'node_modules', 'node-pty')

if (!existsSync(pty)) process.exit(0)
// spawn-helper is a Unix concept; Windows uses conpty.
if (process.platform === 'win32') process.exit(0)

const prebuilt = path.join(pty, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
if (!existsSync(prebuilt)) {
  console.error(`[node-pty] no bundled spawn-helper for ${process.platform}-${process.arch}`)
  process.exit(0)
}

/**
 * Every directory node-pty might load its native module from. The helper must
 * sit BESIDE the loaded binary: unixTerminal.js resolves it as
 * `native.dir + '/spawn-helper'`, so a copy in the wrong directory is invisible.
 */
function nativeDirs() {
  const dirs = [path.join(pty, 'build', 'Release')]
  const bin = path.join(pty, 'bin')
  if (existsSync(bin)) {
    // e.g. bin/darwin-arm64-130 — the Electron ABI build, which is the one the
    // app actually loads.
    for (const entry of readdirSync(bin)) dirs.push(path.join(bin, entry))
  }
  return dirs
}

let repaired = 0
for (const dir of nativeDirs()) {
  const hasModule = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.node'))
  // Only repair beside a real native module. Creating a lone helper next to
  // nothing would hide the fact that the rebuild produced no binary at all.
  const isBuildDir = dir.endsWith(path.join('build', 'Release'))
  if (!hasModule && !isBuildDir) continue
  const target = path.join(dir, 'spawn-helper')
  if (existsSync(target)) continue
  try {
    mkdirSync(dir, { recursive: true })
    copyFileSync(prebuilt, target)
    chmodSync(target, 0o755)
    console.error(`[node-pty] restored spawn-helper in ${path.relative(root, dir)}`)
    repaired += 1
  } catch (error) {
    console.error(`[node-pty] could not restore spawn-helper in ${dir}:`, error)
  }
}

if (repaired > 0) {
  console.error(
    '[node-pty] the native rebuild had removed it; terminals would have failed ' +
      'with "posix_spawnp failed" at spawn time.'
  )
}
