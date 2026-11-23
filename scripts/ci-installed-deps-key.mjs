import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'

const read = (path) => readFileSync(path, 'utf8')

function readNpmConfig() {
  try {
    return read('.npmrc')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

// npm version changes the application's own version in three places without
// changing the installed tree. Keep all other fields, including the manifest:
// a package.json change with a stale lockfile must not bypass npm ci.
const manifest = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
const { version: _appVersion, ...installManifest } = manifest
const { version: _lockVersion, packages, ...installLock } = lock
const { version: _rootVersion, ...root } = packages['']
const scriptPaths = [...String(manifest.scripts?.postinstall ?? '').matchAll(/\bnode (scripts\/[\w-]+\.mjs)\b/g)]
  .map(([, path]) => path)
const installScripts = scriptPaths.map((path) => [path, read(path)])
const inputs = [
  process.platform, process.arch, process.versions.node, process.env.ImageOS, process.env.ImageVersion,
  installManifest, { ...installLock, packages: { ...packages, '': root } },
  readNpmConfig(), installScripts
]
const digest = createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
const line = `key=installed-deps-v1-${process.platform}-${process.arch}-${digest}\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
else process.stdout.write(line)
