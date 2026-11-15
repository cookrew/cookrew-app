// The identity of an installed node_modules, for CI's dependency cache.
//
// WHY NOT hashFiles('package-lock.json'): the lockfile carries the app's own
// version twice (top level and packages['']), and every release bumps it. A
// key on the raw file therefore missed on every release PR — the one PR that
// runs on every release — while not one dependency had changed. This hashes the
// lockfile with those two fields taken out, so the key moves when the TREE
// does and not when the version does.
//
// Also in the key, because they shape what an install leaves on disk:
//   - the postinstall command and the two scripts it runs (electron-rebuild of
//     node-pty, the node-pty repair, cr-listen);
//   - the platform, arch and Node ABI of the Node that ran the install.
//
// Prints `key=<hex>` to $GITHUB_OUTPUT when it is set, and to stdout always.

import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'

const POSTINSTALL_SCRIPTS = ['scripts/ensure-node-pty.mjs', 'scripts/build-cr-listen.mjs']

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`ci-deps-key: cannot read ${file}: ${error.message}`)
  }
}

/** The lockfile minus the app's own version, which is not a dependency. */
export function versionlessLock(lock) {
  const { version: _version, packages = {}, ...rest } = lock
  const { version: _rootVersion, ...root } = packages[''] ?? {}
  return { ...rest, packages: { ...packages, '': root } }
}

export function depsKey({ lock, postinstall, scripts, runtime }) {
  const material = JSON.stringify([versionlessLock(lock), postinstall ?? null, scripts, runtime])
  return createHash('sha256').update(material).digest('hex')
}

function main() {
  const lock = readJson('package-lock.json')
  const pkg = readJson('package.json')
  const scripts = POSTINSTALL_SCRIPTS.map((file) => readFileSync(file, 'utf8'))
  const runtime = [process.platform, process.arch, process.versions.modules]
  const key = depsKey({ lock, postinstall: pkg.scripts?.postinstall, scripts, runtime })
  const line = `key=${key}\n`
  process.stdout.write(line)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
}

// Run as a script, not when a test imports the helpers.
if (process.argv[1]?.endsWith('ci-deps-key.mjs')) main()
