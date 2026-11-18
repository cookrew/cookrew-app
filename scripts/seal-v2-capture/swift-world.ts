// The Mac's end of cookrew-seal/2 behind the real registry, for the Swift client
// (scripts/seal-v2-swift-probe.mjs). Prints one JSON line with the relay prefix,
// a phone session and the connect code, then serves until stdin closes.
//
//   npx vite-node scripts/seal-v2-capture/swift-world.ts
import { createServer, type Server } from 'node:http'
import { loopbackDialer } from '../../src/main/canvas-bridge'
import { isSealPath, routeSeal, type SealTerminus } from '../../src/main/canvas-seal-terminus'
import { connectCodeId, newConnectCode } from '../../src/shared/canvas-seal'
import { RELAY_SESSION_HEADER } from '../../src/shared/machine-relay'
import { startRelayWorld } from '../../tests/support/seal2-relay-world'

// Past one stream's window (1 MiB) both ways, so credit has to flow.
const PICTURE = Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => i % 251))

const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac')
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
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
const world = await startRelayWorld(companion, (port) => ({ codeFor: (asked) => (asked === id ? code : null), dial: loopbackDialer(port) }))
console.log(JSON.stringify({ prefix: world.prefix(), header: RELAY_SESSION_HEADER, value: world.phoneSession[RELAY_SESSION_HEADER], code: Buffer.from(code).toString('base64url') }))
process.stdin.resume()
process.stdin.on('end', () => void world.close().then(() => process.exit(0)))
