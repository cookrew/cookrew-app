// The watch's sealed client (watch/Sources/CookrewCore/Seal2Client.swift) against
// the Mac's real terminus behind the real registry: the Swift and TypeScript ends
// of cookrew-seal/2 talking, not only agreeing on vectors.
//
// Run: node scripts/seal-v2-swift-probe.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const built = spawnSync('swift', ['build', '--product', 'seal2-probe'], { cwd: path.join(root, 'watch'), encoding: 'utf8' })
if (built.status !== 0) {
  console.error(built.stderr.slice(-2000))
  process.exit(1)
}
const world = spawn(path.join(root, 'node_modules/.bin/vite-node'), [path.join(root, 'scripts/seal-v2-capture/swift-world.ts')], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] })
const line = await new Promise((resolve, reject) => {
  createInterface({ input: world.stdout }).once('line', resolve)
  world.once('exit', (code) => reject(new Error(`the Mac end exited ${code}`)))
})
const { prefix, header, value, code } = JSON.parse(line)
const probe = spawnSync(path.join(root, 'watch/.build/debug/seal2-probe'), [prefix, header, value, code], { encoding: 'utf8', timeout: 120_000 })
world.stdin.end()
const result = JSON.parse(probe.stdout.trim().split('\n').at(-1) ?? '{}')
console.log(JSON.stringify(result, null, 2))
const ok = result.ok === true && result.one?.startsWith('200 /api/swift-one') && result.post?.startsWith('200 /api/swift-post got 3000000') && result.picture === 3_000_000 && result.pictureIntact === true && result.many === 40
console.log(ok ? 'PASS: the Swift client and the TypeScript terminus speak cookrew-seal/2 through the registry' : 'FAIL')
process.exit(ok ? 0 : 1)
