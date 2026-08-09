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
// TWO files matter, and missing either produces the same symptom.
// utils.js searches `build/Release/pty.node`, then build/Debug, then
// prebuilds/<platform>-<arch> — and `spawn-helper` must sit in whichever of
// those directories won, because unixTerminal.js resolves it as
// `native.dir + '/spawn-helper'`.
//
// A clean that removes build/Release therefore does something subtle: the
// loader silently falls through to prebuilds, `require` succeeds, and only
// forking fails. Restoring the helper alone is not enough — the ABI-matched
// module has to go back where the loader looks first. electron-rebuild leaves
// its output in bin/<platform>-<arch>-<abi>/node-pty.node, which the loader
// never reads, so that copy is the source of the repair.

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

/**
 * Put the ABI-matched module back where the loader looks FIRST.
 *
 * electron-rebuild writes bin/<platform>-<arch>-<abi>/node-pty.node, a name
 * and location loadNativeModule() never checks. When build/Release has lost
 * pty.node, restoring it from there is what makes the app load the Electron
 * build instead of falling through to the node-ABI prebuild.
 */
function restoreModule() {
  const release = path.join(pty, 'build', 'Release')
  if (existsSync(path.join(release, 'pty.node'))) return false
  const bin = path.join(pty, 'bin')
  if (!existsSync(bin)) return false
  for (const entry of readdirSync(bin)) {
    const built = path.join(bin, entry, 'node-pty.node')
    if (!existsSync(built)) continue
    try {
      mkdirSync(release, { recursive: true })
      copyFileSync(built, path.join(release, 'pty.node'))
      console.error(`[node-pty] restored pty.node in build/Release from bin/${entry}`)
      return true
    } catch (error) {
      console.error('[node-pty] could not restore pty.node:', error)
    }
  }
  return false
}

let repaired = restoreModule() ? 1 : 0
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
