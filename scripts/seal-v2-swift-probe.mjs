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
const world_ = JSON.parse(line)
const { prefix, header, value, code } = world_
const lines = createInterface({ input: world.stdout })
const probe = (...args) => {
  const ran = spawnSync(path.join(root, 'watch/.build/debug/seal2-probe'), args, { encoding: 'utf8', timeout: 180_000 })
  return JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}')
}
const full = (result) => result.ok === true && result.one?.startsWith('200 /api/swift-one') && result.post?.startsWith('200 /api/swift-post got 3000000') && result.picture === 3_000_000 && result.pictureIntact === true && result.many === 90 && result.badHeader === 'refused' && result.afterBad === 200

const viaCode = probe('code', prefix, header, value, code)
const appArgs = ['app', prefix, header, value, world_.macId, world_.macX, world_.watchId, world_.watchSeed]
const appBefore = probe(...appArgs)
const deviceArgs = ['device', prefix, header, value, world_.macId, world_.macX, world_.watchId, world_.watchSeed]
const beforeConfirm = probe(...deviceArgs)
const said = () => new Promise((resolve) => lines.once('line', (line) => resolve(JSON.parse(line))))
world.stdin.write('stats\n')
const beforeStats = await said()
world.stdin.write('confirm\n')
await said()
const afterConfirm = probe(...deviceArgs)
const appAfter = probe(...appArgs)
world.stdin.write('stats\n')
const afterStats = await said()
world.stdin.end()
const sends = (stats) => stats.seen.filter((row) => row.path === '/api/terminal/t1/input')
const appPlainBefore = sends(beforeStats).length === 1 && sends(beforeStats)[0].plain === true
const appSealedAfter = sends(afterStats).length === 2 && sends(afterStats)[1].plain === false
console.log(JSON.stringify({ appBefore, appAfter, watchCalls: sends(afterStats) }, null, 2))
console.log(JSON.stringify({ viaCode, beforeConfirm: { ok: beforeConfirm.ok, error: beforeConfirm.error }, afterConfirm }, null, 2))
const ok = appBefore.sent === true && appBefore.pinned === false && appPlainBefore && appAfter.sent === true && appAfter.pinned === true && appSealedAfter && full(viaCode) && beforeConfirm.ok === false && /refused/.test(beforeConfirm.error ?? '') && full(afterConfirm) && Array.isArray(afterConfirm.words) && afterConfirm.words.length === 6
console.log(ok ? 'PASS: the Swift client speaks cookrew-seal/2 to the real terminus through the registry, by connect code and as a watch in device mode (refused until confirmed); the watch app\'s own calls go plain before the owner confirms and sealed, pinned, after' : 'FAIL')
process.exit(ok ? 0 : 1)
