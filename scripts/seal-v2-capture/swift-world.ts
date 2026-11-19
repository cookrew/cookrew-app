// The Mac's end of cookrew-seal/2 behind the real registry, for the Swift client
// (scripts/seal-v2-swift-probe.mjs). Prints one JSON line with the relay prefix,
// a phone session and the connect code, then serves until stdin closes.
//
//   npx vite-node scripts/seal-v2-capture/swift-world.ts
import { createServer, type Server } from 'node:http'
import { loopbackDialer } from '../../src/main/canvas-bridge'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cameOverRelayLine, sealedPeerOf, sealProofHeaders } from '../../src/main/seal-proof'
import { createSealMarks } from '../../src/main/seal-marks'
import { takeRelayDevice } from '../../src/main/relay-device'
import { isSealPath, routeSeal, type SealTerminus } from '../../src/main/canvas-seal-terminus'
import { connectCodeId, newConnectCode } from '../../src/shared/canvas-seal'
import { RELAY_SESSION_HEADER } from '../../src/shared/machine-relay'
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { startRelayWorld, verifyDevice } from '../../tests/support/seal2-relay-world'

// Past one stream's window (1 MiB) both ways, so credit has to flow.
const PICTURE = Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => i % 251))

/** Every request that reached the Mac, and whether it came down the relay line in the clear. */
const seen: Array<{ path: string; plain: boolean }> = []

/** As the Mac does it (seal-marks.ts, watch-routes.ts · handleWatchRekey): marks, the watch's token, its trade. */
const marks = createSealMarks(path.join(mkdtempSync(path.join(tmpdir(), 'swift-world-')), 'marks.json'))
const claimToken = `claim-token-${randomBytes(12).toString('base64url')}`
let watchToken = claimToken

const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac')
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    const device = takeRelayDevice(request)
    const plain = cameOverRelayLine(request)
    if (plain && marks.refuses(device?.deviceId ?? null)) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'sealed-only' }))
      return
    }
    seen.push({ path: url.pathname, plain })
    const watchRoute = url.pathname.startsWith('/api/terminal/') || url.pathname.startsWith('/api/watch/')
    if (watchRoute && request.headers.authorization !== `Bearer ${watchToken}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unpaired' }))
      return
    }
    if (url.pathname === '/api/watch/rekey') {
      // Only inside the confirmed watch's own sealed session, as handleWatchRekey asks.
      if (!confirmed || sealedPeerOf(request) !== watchId) {
        response.writeHead(404)
        response.end()
        return
      }
      watchToken = `traded-${randomBytes(12).toString('base64url')}`
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, token: watchToken }))
      return
    }
    if (url.pathname === '/api/picture') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(PICTURE)
      return
    }
    let size = 0
    request.on('data', (chunk: Buffer) => (size += chunk.length))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`${url.pathname} got ${size} auth=${request.headers.authorization ?? 'none'}`)
    })
  })

const code = newConnectCode()
const id = await connectCodeId(code)
// A watch: an Ed25519 account key from a seed the Swift probe is handed, and the phone session's random
// device id as its id (a watch's id is not its key's). Its key is let in only once "confirm" comes on stdin,
// as the owner's click on the Mac's six words.
const seed = randomBytes(32)
const watchKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
const watchX = (createPublicKey(watchKey).export({ format: 'jwk' }) as { x: string }).x
let confirmed = false
let watchId = ''
const world = await startRelayWorld(companion, (port, mac) => ({
  codeFor: (asked) => (asked === id ? code : null),
  dial: loopbackDialer(port, undefined, sealProofHeaders()),
  deviceHttp: (deviceId) => confirmed && deviceId === watchId,
  onSealed: ({ peer }) => {
    if (peer.mode === 'device' && confirmed && peer.deviceId === watchId) marks.mark(peer.deviceId)
  },
  device: {
    self: () => mac.signer,
    verify: verifyDevice,
    trusted: async (deviceId) => confirmed && deviceId === watchId,
    keyOf: async (deviceId) => (confirmed && deviceId === watchId ? { kty: 'OKP', crv: 'Ed25519', x: watchX } : null)
  }
}))
watchId = world.phoneDeviceId
console.log(
  JSON.stringify({
    prefix: world.prefix(),
    header: RELAY_SESSION_HEADER,
    value: world.phoneSession[RELAY_SESSION_HEADER],
    code: Buffer.from(code).toString('base64url'),
    macId: world.macDevice.id,
    macX: world.macDevice.jwk.x,
    watchId,
    watchSeed: seed.toString('hex'),
    watchToken: claimToken
  })
)
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'confirm') confirmed = true
  console.log(JSON.stringify({ confirmed, seen, traded: watchToken !== claimToken }))
})
process.stdin.on('end', () => void world.close().then(() => process.exit(0)))
