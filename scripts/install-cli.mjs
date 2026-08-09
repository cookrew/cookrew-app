#!/usr/bin/env node
// Put `cookrew` on the system PATH.
//
// WHY A LAUNCHER AND NOT A SYMLINK
// --------------------------------
// The app already installs a copy of this CLI into its runtime dir
// (/tmp/cookrew-runtime) and injects that dir into every pane's PATH — which is
// why `cookrew` works inside an agent's terminal and nowhere else.
//
// Symlinking to that copy would be the obvious move and it is wrong: the
// runtime dir lives under the OS temp dir, so it is cleared by a reboot and only
// rewritten when the app next launches. The symlink would dangle exactly when a
// user reaches for the CLI to find out why the app is not responding.
//
// So this writes a tiny launcher that resolves the script at RUN time, prefers
// the app's runtime copy, and falls back to this checkout. It keeps working
// across reboots and picks up edits to cli/cookrew.mjs without reinstalling.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { launcherScript, pickBinDir } from './install-cli-lib.mjs'
import process from 'node:process'

const REPO_CLI = path.resolve(import.meta.dirname, '..', 'cli', 'cookrew.mjs')
const RUNTIME_CLI = path.join(tmpdir(), 'cookrew-runtime', 'cookrew.mjs')

function main() {
  const explicit = process.env.COOKREW_BIN_DIR
  const candidates = explicit
    ? [explicit]
    : [path.join(homedir(), '.local', 'bin'), '/usr/local/bin']

  const writable = (dir) => {
    try {
      mkdirSync(dir, { recursive: true })
      // A dir we just created is writable; an existing one may not be.
      const probe = path.join(dir, `.cookrew-write-probe-${process.pid}`)
      writeFileSync(probe, '')
      rmSync(probe)
      return true
    } catch {
      return false
    }
  }

  const dir = pickBinDir(candidates, writable)
  if (!dir) {
    console.error(`cookrew: no writable install dir among ${candidates.join(', ')}`)
    console.error('Set COOKREW_BIN_DIR to a directory on your PATH and retry.')
    process.exit(1)
  }

  const target = path.join(dir, 'cookrew')
  writeFileSync(target, launcherScript(RUNTIME_CLI, REPO_CLI, process.execPath))
  chmodSync(target, 0o755)

  console.log(`installed: ${target}`)
  console.log(`  runtime CLI: ${RUNTIME_CLI}${existsSync(RUNTIME_CLI) ? '' : '  (appears after the app launches)'}`)
  console.log(`  fallback   : ${REPO_CLI}`)
  console.log(`  node       : ${process.execPath}`)

  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir)
  if (!onPath) {
    console.log('')
    console.log(`WARNING: ${dir} is not on your PATH. Add it:`)
    console.log(`  export PATH="${dir}:$PATH"`)
  }
  console.log('')
  console.log('Outside an agent terminal there is no caller identity, so name one:')
  console.log('  cookrew list --all                  # no identity needed')
  console.log('  cookrew --as "Conductor" list       # speak as an agent')
}

if (process.argv[1] && process.argv[1].endsWith('install-cli.mjs')) main()
